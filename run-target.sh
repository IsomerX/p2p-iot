#!/bin/bash
# Script to run the target with a Bun-compatible implementation

# Make sure we're in the project root directory
cd "$(dirname "$0")"

echo "Setting up mock key simulator..."

# Create the mock implementation
cat >src/target/mockKeySimulator.ts <<'EOL'
import { createLogger } from '../shared/utils';

const logger = createLogger('MockKeySimulator');

/**
 * Interface for key simulator options
 */
interface KeySimulatorOptions {
  /**
   * Whether to log detailed information about key presses
   */
  verbose?: boolean;
}

/**
 * Interface for key press options
 */
interface KeyPressOptions {
  /**
   * Number of times to repeat the key press
   */
  repeat?: number;
  
  /**
   * How long to hold the key down (in milliseconds)
   */
  holdTime?: number;
  
  /**
   * Delay between key presses when repeating (in milliseconds)
   */
  delay?: number;
}

/**
 * Mock implementation of KeySimulator that doesn't require external packages
 * Just logs the key presses instead of actually simulating them
 */
class MockKeySimulator {
  private readonly verbose: boolean;
  
  constructor(options: KeySimulatorOptions = {}) {
    this.verbose = options.verbose || false;
    logger.info('Using mock key simulator - key presses will be logged but not actually simulated');
  }
  
  /**
   * Press the left arrow key
   */
  public async pressLeftArrow(options: KeyPressOptions = {}): Promise<boolean> {
    return this.pressKey('left', options);
  }
  
  /**
   * Press the right arrow key
   */
  public async pressRightArrow(options: KeyPressOptions = {}): Promise<boolean> {
    return this.pressKey('right', options);
  }
  
  /**
   * Press a key
   */
  public async pressKey(key: string, options: KeyPressOptions = {}): Promise<boolean> {
    const repeat = options.repeat || 1;
    const holdTime = options.holdTime || 0;
    const delay = options.delay || 50;
    
    logger.info(`MOCK: Simulating key press: ${key} (repeat: ${repeat}, holdTime: ${holdTime}ms, delay: ${delay}ms)`);
    
    if (this.verbose) {
      for (let i = 0; i < repeat; i++) {
        logger.info(`MOCK: Press ${i + 1}/${repeat}: ${key}`);
        if (holdTime > 0) {
          logger.info(`MOCK: Holding ${key} for ${holdTime}ms`);
        }
        if (i < repeat - 1 && delay > 0) {
          logger.info(`MOCK: Waiting ${delay}ms before next press`);
        }
        
        // Simulate the delay to make the experience more realistic
        await this.sleep(Math.min(delay, 50)); // Cap at 50ms for testing purposes
      }
    }
    
    return true;
  }
  
  /**
   * Asynchronous sleep function
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MockKeySimulator;
EOL

echo "Creating simplified control client (without UDP)..."

# Create the simplified control client
cat >src/target/simplifiedControlClient.ts <<'EOL'
import * as WebSocket from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { 
  DEFAULT_WEBSOCKET_PORT, 
  MESSAGE_TYPES,
  COMMAND_TYPES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  WS_PING_INTERVAL
} from '../shared/constants';
import { 
  DeviceType, 
  DeviceInfo, 
  ConnectionStatus, 
  ProtocolMessage,
  CommandMessage,
  RegisterMessage,
  ArrowCommandParameters
} from '../shared/types';
import { 
  createBaseMessage, 
  createErrorMessage, 
  validateMessage, 
  parseJsonMessage, 
  createLogger,
  getLocalIpAddress
} from '../shared/utils';

const logger = createLogger('SimplifiedControlClient');

interface ControlClientOptions {
  deviceId?: string;
  deviceName?: string;
  controllerIp?: string;
  controllerPort?: number;
  autoConnect?: boolean;
  heartbeatInterval?: number;
  supportedCommands?: string[];
  onArrowCommand?: (direction: 'left' | 'right', options: { repeat: number; holdTime: number }) => Promise<boolean>;
}

/**
 * A simplified control client that doesn't use UDP for discovery
 * This is compatible with Bun which currently doesn't support dgram
 */
class SimplifiedControlClient extends EventEmitter {
  private readonly options: Required<ControlClientOptions>;
  private readonly deviceInfo: DeviceInfo;
  private controllerInfo: { ip: string; port: number } | null = null;
  private ws: WebSocket | null = null;
  private heartbeatIntervalId: NodeJS.Timeout | null = null;
  private reconnectTimeoutId: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private authToken?: string;
  private pairingToken?: string;
  private lastHeartbeatTime: number = 0;

  constructor(options: ControlClientOptions = {}) {
    super();
    
    // Set default options
    this.options = {
      deviceId: options.deviceId || uuidv4(),
      deviceName: options.deviceName || `ArrowTarget-${uuidv4().substring(0, 8)}`,
      controllerIp: options.controllerIp || '127.0.0.1', // Default to localhost
      controllerPort: options.controllerPort || DEFAULT_WEBSOCKET_PORT,
      autoConnect: options.autoConnect !== undefined ? options.autoConnect : true,
      heartbeatInterval: options.heartbeatInterval || WS_PING_INTERVAL,
      supportedCommands: options.supportedCommands || [COMMAND_TYPES.ARROW_LEFT, COMMAND_TYPES.ARROW_RIGHT],
      onArrowCommand: options.onArrowCommand || (async () => false)
    };
    
    // Create device info
    this.deviceInfo = {
      id: this.options.deviceId,
      name: this.options.deviceName,
      ip: getLocalIpAddress() || '127.0.0.1',
      type: DeviceType.TARGET,
      supportedCommands: this.options.supportedCommands
    };
    
    // Store controller info
    this.controllerInfo = {
      ip: this.options.controllerIp,
      port: this.options.controllerPort
    };
    
    // Start auto-connect if enabled
    if (this.options.autoConnect) {
      this.connect(this.options.controllerIp, this.options.controllerPort)
        .catch(error => {
          logger.error('Error auto-connecting', error);
        });
    }
  }

  /**
   * Get current connection status
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get device info
   */
  public getDeviceInfo(): DeviceInfo {
    return this.deviceInfo;
  }

  /**
   * Get controller info
   */
  public getControllerInfo(): { ip: string; port: number } | null {
    return this.controllerInfo;
  }

  /**
   * Connect to a controller
   */
  public connect(ip: string, port: number = DEFAULT_WEBSOCKET_PORT): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        logger.warn('Already connected to a controller');
        resolve(false);
        return;
      }
      
      logger.info(`Connecting to controller at ${ip}:${port}`);
      
      try {
        // Update status
        this.status = ConnectionStatus.CONNECTING;
        this.emit('statusChanged', this.status);
        
        // Store controller info
        this.controllerInfo = { ip, port };
        
        // Create WebSocket
        this.ws = new WebSocket(`ws://${ip}:${port}`);
        
        // Handle WebSocket events
        this.ws.on('open', () => {
          logger.info('Connected to controller');
          this.status = ConnectionStatus.CONNECTED;
          this.emit('statusChanged', this.status);
          
          // Register device
          this.sendRegistration();
          
          // Start heartbeat
          this.startHeartbeat();
          
          // Reset reconnect attempts
          this.reconnectAttempts = 0;
          
          resolve(true);
        });
        
        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });
        
        this.ws.on('close', () => {
          logger.info('Disconnected from controller');
          this.handleDisconnection();
          resolve(false);
        });
        
        this.ws.on('error', (error) => {
          logger.error('WebSocket error', error);
          this.handleDisconnection();
          this.emit('error', { type: 'connection', error });
          reject(error);
        });
      } catch (error) {
        logger.error('Error connecting to controller', error);
        this.handleDisconnection();
        this.emit('error', { type: 'connection', error });
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the controller
   */
  public disconnect(): void {
    // Stop reconnect attempts
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    // Stop heartbeat
    this.stopHeartbeat();
    


// Close WebSocket
    if (this.ws) {
      try {
        this.ws.close();
        this.ws = null;
      } catch (error) {
        logger.error('Error closing WebSocket', error);
      }
    }
    
    // Update status
    this.status = ConnectionStatus.DISCONNECTED;
    this.emit('statusChanged', this.status);
    
    logger.info('Disconnected from controller');
  }

  /**
   * Send a registration message to the controller
   */
  private sendRegistration(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('Cannot register device: WebSocket not connected');
      return;
    }
    
    try {
      // Create registration message
      const message: RegisterMessage = {
        ...createBaseMessage(MESSAGE_TYPES.REGISTER, this.deviceInfo.id, DeviceType.TARGET),
        data: {
          deviceInfo: this.deviceInfo
        }
      };
      
      // Send message
      this.ws.send(JSON.stringify(message));
      logger.info('Sent device registration');
    } catch (error) {
      logger.error('Error sending registration', error);
    }
  }

  /**
   * Send a pairing request to the controller
   */
  public sendPairingRequest(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.error('Cannot send pairing request: WebSocket not connected');
        reject(new Error('Not connected to controller'));
        return;
      }
      
      if (!this.pairingToken) {
        logger.error('Cannot send pairing request: No pairing token available');
        reject(new Error('No pairing token available'));
        return;
      }
      
      try {
        // Create pairing request message
        const message: ProtocolMessage = {
          ...createBaseMessage(MESSAGE_TYPES.PAIRING_REQUEST, this.deviceInfo.id, DeviceType.TARGET),
          data: {
            pairingToken: this.pairingToken
          }
        };
        
        // Send message
        this.ws.send(JSON.stringify(message));
        logger.info('Sent pairing request');
        
        // We'll get the response asynchronously via handleMessage
        // The promise will be resolved/rejected there
        this.once('pairingResult', (result: { success: boolean; error?: string }) => {
          if (result.success) {
            resolve(true);
          } else {
            reject(new Error(result.error || 'Pairing failed'));
          }
        });
      } catch (error) {
        logger.error('Error sending pairing request', error);
        reject(error);
      }
    });
  }

  /**
   * Send a heartbeat to the controller
   */
  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    try {
      // Create heartbeat message
      const message: ProtocolMessage = {
        ...createBaseMessage(MESSAGE_TYPES.HEARTBEAT, this.deviceInfo.id, DeviceType.TARGET),
        data: {}
      };
      
      // Send message
      this.ws.send(JSON.stringify(message));
      this.lastHeartbeatTime = Date.now();
      logger.debug('Sent heartbeat');
    } catch (error) {
      logger.error('Error sending heartbeat', error);
    }
  }

  /**
   * Send a command result to the controller
   */
  private sendCommandResult(commandType: string, success: boolean, error?: string, result?: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('Cannot send command result: WebSocket not connected');
      return;
    }
    
    try {
      // Create command result message
      const message: ProtocolMessage = {
        ...createBaseMessage(MESSAGE_TYPES.COMMAND_RESULT, this.deviceInfo.id, DeviceType.TARGET),
        data: {
          commandType,
          success,
          error,
          result
        }
      };
      
      // Send message
      this.ws.send(JSON.stringify(message));
      logger.debug(`Sent command result: ${commandType} ${success ? 'succeeded' : 'failed'}`);
    } catch (error) {
      logger.error('Error sending command result', error);
    }
  }

  /**
   * Handle a WebSocket message
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      // Parse message
      const { valid, message, error } = parseJsonMessage(data.toString());
      if (!valid || !message) {
        logger.warn(`Invalid message: ${error}`);
        return;
      }
      
      // Validate message
      const validation = validateMessage(message);
      if (!validation.valid) {
        logger.warn(`Invalid message: ${validation.error}`);
        return;
      }
      
      // Handle message based on type
      switch (message.type) {
        case MESSAGE_TYPES.REGISTERED:
          this.handleRegisteredMessage(message);
          break;
        case MESSAGE_TYPES.PAIRING_RESPONSE:
          this.handlePairingResponseMessage(message);
          break;
        case MESSAGE_TYPES.COMMAND:
          this.handleCommandMessage(message as CommandMessage);
          break;
        case MESSAGE_TYPES.HEARTBEAT_ACK:
          // Just log the heartbeat acknowledgement
          logger.debug('Received heartbeat acknowledgement');
          break;
        case MESSAGE_TYPES.ERROR:
          this.handleErrorMessage(message);
          break;
        default:
          logger.warn(`Unhandled message type: ${message.type}`);
      }
    } catch (error) {
      logger.error('Error handling message', error);
    }
  }

  /**
   * Handle a registered message
   */
  private handleRegisteredMessage(message: any): void {
    const { deviceId, pairingRequired, pairingToken } = message.data;
    
    if (deviceId !== this.deviceInfo.id) {
      logger.warn(`Received registration for different device ID: ${deviceId}`);
      return;
    }
    
    logger.info(`Device registered with controller ${pairingRequired ? '(pairing required)' : '(no pairing required)'}`);
    
    // Update pairing status
    if (pairingRequired) {
      this.status = ConnectionStatus.CONNECTED;
      
      // Store pairing token for later use
      this.pairingToken = pairingToken;
      
      // Emit pairing required event
      this.emit('pairingRequired', pairingToken);
    } else {
      this.status = ConnectionStatus.PAIRED;
      
      // Emit registered event
      this.emit('registered');
    }
    
    // Emit status change
    this.emit('statusChanged', this.status);
  }

  /**
   * Handle a pairing response message
   */
  private handlePairingResponseMessage(message: any): void {
    const { accepted, authToken, error } = message.data;
    
    if (accepted) {
      logger.info('Pairing accepted');
      
      // Store auth token
      this.authToken = authToken;
      
      // Update status
      this.status = ConnectionStatus.PAIRED;
      this.emit('statusChanged', this.status);
      
      // Emit pairing result event
      this.emit('pairingResult', { success: true });
    } else {
      logger.warn(`Pairing rejected: ${error}`);
      
      // Emit pairing result event
      this.emit('pairingResult', { success: false, error });
    }
  }

  /**
   * Handle a command message
   */
  private async handleCommandMessage(message: CommandMessage): Promise<void> {
    const { commandType, parameters } = message.data;
    
    // Check if command is supported
    if (!this.deviceInfo.supportedCommands.includes(commandType)) {
      logger.warn(`Received unsupported command: ${commandType}`);
      this.sendCommandResult(commandType, false, 'Unsupported command');
      return;
    }
    
    // Handle arrow commands
    if (commandType === COMMAND_TYPES.ARROW_LEFT || commandType === COMMAND_TYPES.ARROW_RIGHT) {
      const direction = commandType === COMMAND_TYPES.ARROW_LEFT ? 'left' : 'right';
      const options = {
        repeat: (parameters as ArrowCommandParameters)?.repeat || 1,
        holdTime: (parameters as ArrowCommandParameters)?.holdTime || 0,
      };
      
      try {
        logger.info(`Executing arrow command: ${direction} (repeat: ${options.repeat}, holdTime: ${options.holdTime}ms)`);
        
        // Execute arrow command
        const success = await this.options.onArrowCommand(direction, options);
        
        if (success) {
          logger.info(`Arrow command executed successfully: ${direction}`);
          this.sendCommandResult(commandType, true);
        } else {
          logger.warn(`Arrow command execution failed: ${direction}`);
          this.sendCommandResult(commandType, false, 'Command execution failed');
        }
        
        // Emit command event
        this.emit('command', {
          type: commandType,
          direction,
          options,
          success
        });
      } catch (error) {
        logger.error(`Error executing arrow command: ${direction}`, error);
        this.sendCommandResult(commandType, false, 'Internal error');
      }
    } else {
      logger.warn(`Unhandled command type: ${commandType}`);
      this.sendCommandResult(commandType, false, 'Unhandled command');
    }
  }

  /**
   * Handle an error message
   */
  private handleErrorMessage(message: any): void {
    const { code, message: errorMessage } = message.data;
    
    logger.warn(`Received error from controller: [${code}] ${errorMessage}`);
    
    // Emit error event
    this.emit('controllerError', { code, message: errorMessage });
    
    // Handle specific error codes
    switch (code) {
      case ERROR_CODES.AUTHENTICATION_FAILED:
        // Reset auth token and pairing token
        this.authToken = undefined;
        this.pairingToken = undefined;
        
        // Update status
        if (this.status === ConnectionStatus.PAIRED) {
          this.status = ConnectionStatus.CONNECTED;
          this.emit('statusChanged', this.status);
        }
        break;
      
      case ERROR_CODES.NOT_PAIRED:
        // Update status
        if (this.status === ConnectionStatus.PAIRED) {
          this.status = ConnectionStatus.CONNECTED;
          this.emit('statusChanged', this.status);
        }
        break;
    }
  }

  /**
   * Handle disconnection from the controller
   */
  private handleDisconnection(): void {
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Clear WebSocket
    this.ws = null;
    
    // Update status
    this.status = ConnectionStatus.DISCONNECTED;
    this.emit('statusChanged', this.status);
    
    // Attempt to reconnect if auto-connect is enabled
    if (this.options.autoConnect && this.controllerInfo) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
    }
    
    // Calculate backoff time
    const backoffTime = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    logger.info(`Scheduling reconnect attempt in ${backoffTime}ms`);
    
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectAttempts++;
      
      if (this.reconnectAttempts > this.maxReconnectAttempts) {
        logger.warn('Max reconnect attempts reached, giving up');
        return;
      }
      
      logger.info(`Reconnect attempt ${this.reconnectAttempts}`);
      
      if (this.controllerInfo) {
        this.connect(this.controllerInfo.ip, this.controllerInfo.port).catch(error => {
          logger.error('Reconnect attempt failed', error);
          this.scheduleReconnect();
        });
      }
    }, backoffTime);
  }

  /**
   * Start sending heartbeats
   */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
    }
    
    this.heartbeatIntervalId = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.heartbeatInterval);
    
    // Send initial heartbeat
    this.sendHeartbeat();
  }

  /**
   * Stop sending heartbeats
   */
  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
  }

  /**
   * Manually set the controller IP and port
   * This is used instead of discovery in this simplified version
   */
  public setControllerAddress(ip: string, port: number): void {
    this.controllerInfo = { ip, port };
    logger.info(`Controller address set to ${ip}:${port}`);
  }
}

export default SimplifiedControlClient;
EOL

echo "Creating Bun-compatible target..."

# Create the Bun-compatible target
cat >src/target/bunTarget.ts <<'EOL'
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import SimplifiedControlClient from './simplifiedControlClient';
import MockKeySimulator from './mockKeySimulator';
import { TargetDeviceConfig, TargetDeviceStatus } from './types';
import { createLogger } from '../shared/utils';
import { ConnectionStatus, DeviceType } from '../shared/types';
import { COMMAND_TYPES, DEFAULT_WEBSOCKET_PORT, WS_PING_INTERVAL } from '../shared/constants';

// Load environment variables
dotenv.config();

const logger = createLogger('TargetDevice');

/**
 * Main target device class
 * Bun-compatible version that doesn't use UDP discovery
 */
class BunTargetDevice {
  private readonly config: Required<TargetDeviceConfig>;
  private readonly controlClient: SimplifiedControlClient;
  private readonly keySimulator: MockKeySimulator;
  private readonly startTime: number = Date.now();
  private lastCommandTime: number = 0;
  private lastCommandType: string = '';
  private pairingPromptTimeout: NodeJS.Timeout | null = null;

  constructor(config: TargetDeviceConfig = {}) {
    // Initialize configuration with defaults
    this.config = {
      deviceId: config.deviceId || process.env.DEVICE_ID || uuidv4(),
      deviceName: config.deviceName || process.env.DEVICE_NAME || `ArrowTarget-${Date.now().toString(36)}`,
      discoveryPort: config.discoveryPort || Number(process.env.DISCOVERY_PORT) || 3000,
      autoConnect: config.autoConnect !== undefined ? config.autoConnect : true,
      autoAcceptPairing: config.autoAcceptPairing !== undefined ? config.autoAcceptPairing : false,
      keySimulatorEngine: config.keySimulatorEngine || 'robotjs',
      keySimulatorVerbose: config.keySimulatorVerbose !== undefined ? config.keySimulatorVerbose : false,
      heartbeatInterval: config.heartbeatInterval || Number(process.env.HEARTBEAT_INTERVAL) || WS_PING_INTERVAL,
      reconnectMaxAttempts: config.reconnectMaxAttempts || 10,
      reconnectInitialDelay: config.reconnectInitialDelay || 1000,
    };

    // Initialize key simulator
    this.keySimulator = new MockKeySimulator({
      verbose: this.config.keySimulatorVerbose
    });

    // Initialize control client
    this.controlClient = new SimplifiedControlClient({
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      controllerIp: process.env.CONTROLLER_IP || '127.0.0.1',
      controllerPort: Number(process.env.WEBSOCKET_PORT) || DEFAULT_WEBSOCKET_PORT,
      autoConnect: this.config.autoConnect,
      heartbeatInterval: this.config.heartbeatInterval,
      supportedCommands: [COMMAND_TYPES.ARROW_LEFT, COMMAND_TYPES.ARROW_RIGHT],
      onArrowCommand: this.handleArrowCommand.bind(this)
    });

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Start the target device
   */
  public start(): void {
    logger.info(`Starting target device: ${this.config.deviceName} (${this.config.deviceId})`);
    
    // Log configuration
    logger.info('Configuration:');
    Object.entries(this.config).forEach(([key, value]) => {
      logger.info(`  ${key}: ${value}`);
    });

    logger.info('Target device started');
  }

  /**
   * Stop the target device
   */
  public stop(): void {
    logger.info('Stopping target device');
    
    // Clear pairing prompt timeout
    if (this.pairingPromptTimeout) {
      clearTimeout(this.pairingPromptTimeout);
      this.pairingPromptTimeout = null;
    }
    
    // Disconnect from controller
    this.controlClient.disconnect();
    
    logger.info('Target device stopped');
  }

  /**
   * Connect to a specific controller
   */
  public async connectToController(ip: string, port: number): Promise<boolean> {
    try {
      return await this.controlClient.connect(ip, port);
    } catch (error) {
      logger.error(`Error connecting to controller at ${ip}:${port}`, error);
      return false;
    }
  }

  /**
   * Disconnect from the current controller
   */
  public disconnect(): void {
    this.controlClient.disconnect();
  }

  /**
   * Get the current status of the target device
   */
  public getStatus(): TargetDeviceStatus {
    const deviceInfo = this.controlClient.getDeviceInfo();
    const connectionStatus = this.controlClient.getStatus();
    const controllerInfo = this.controlClient.getControllerInfo();
    
    return {
      deviceInfo,
      connectionStatus,
      controllerInfo: controllerInfo ? {
        ip: controllerInfo.ip,
        port: controllerInfo.port
      } : null,
      paired: connectionStatus === ConnectionStatus.PAIRED,
      lastCommandTime: this.lastCommandTime || undefined,
      lastCommandType: this.lastCommandType || undefined,
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * Handle arrow key commands
   */
  private async handleArrowCommand(
    direction: 'left' | 'right', 
    options: { repeat: number; holdTime: number }
  ): Promise<boolean> {
    // Update command tracking
    this.lastCommandTime = Date.now();
    this.lastCommandType = direction === 'left' ? COMMAND_TYPES.ARROW_LEFT : COMMAND_TYPES.ARROW_RIGHT;
    
    logger.info(`Received ${direction} arrow command (repeat: ${options.repeat}, holdTime: ${options.holdTime}ms)`);
    
    // Execute the key press
    let success = false;
    if (direction === 'left') {
      success = await this.keySimulator.pressLeftArrow(options);
    } else if (direction === 'right') {
      success = await this.keySimulator.pressRightArrow(options);
    }
    
    return success;
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Connection status changes
    this.controlClient.on('statusChanged', (status) => {
      logger.info(`Connection status changed: ${status}`);
    });
    
    // Pairing events
    this.controlClient.on('pairingRequired', (pairingToken) => {
      logger.info('Pairing required');
      
      if (this.config.autoAcceptPairing) {
        logger.info('Auto-accepting pairing request');
        this.controlClient.sendPairingRequest().catch(error => {
          logger.error('Error auto-accepting pairing', error);
        });
      } else {
        // Display pairing prompt and wait for user response
        this.showPairingPrompt(pairingToken);
      }
    });
    
    this.controlClient.on('pairingResult', (result) => {
      if (result.success) {
        logger.info('Pairing successful');
      } else {
        logger.warn(`Pairing failed: ${result.error}`);
      }
    });
    
    // Command events
    this.controlClient.on('command', (command) => {
      logger.info(`Executed command: ${command.type} (success: ${command.success})`);
    });
    
    // Error events
    this.controlClient.on('error', ({ type, error }) => {
      logger.error(`${type} error:`, error);
    });
    
    this.controlClient.on('controllerError', ({ code, message }) => {
      logger.warn(`Controller error [${code}]: ${message}`);
    });
  }

  /**
   * Show a pairing prompt to the user
   */
  private showPairingPrompt(pairingToken: string): void {
    // Clear any existing prompt timeout
    if (this.pairingPromptTimeout) {
      clearTimeout(this.pairingPromptTimeout);
    }
    
    // Display pairing information
    console.log('\n========================================');
    console.log('           PAIRING REQUIRED            ');
    console.log('========================================');
    console.log(`Device: ${this.config.deviceName}`);
    console.log(`Pairing Token: ${pairingToken}`);
    console.log('');
    console.log('To accept the pairing request, press:');
    console.log('  Y - Accept pairing');
    console.log('  N - Reject pairing');
    console.log('========================================\n');
    
    // Set up keyboard input handling for the prompt
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const onKeyPress = (key: string) => {
      // Handle user input
      if (key.toLowerCase() === 'y') {
        // Accept pairing
        console.log('Accepting pairing request...');
        stdin.removeListener('data', onKeyPress);
        stdin.setRawMode(false);
        stdin.pause();
        
        this.controlClient.sendPairingRequest().catch(error => {
          logger.error('Error accepting pairing', error);
        });
      } else if (key.toLowerCase() === 'n') {
        // Reject pairing
        console.log('Rejecting pairing request...');
        stdin.removeListener('data', onKeyPress);
        stdin.setRawMode(false);
        stdin.pause();
      } else if (key === '\u0003') {
        // Handle Ctrl+C
        process.exit();
      }
    };
    
    // Listen for key presses
    stdin.on('data', onKeyPress);
    
    // Set timeout for the prompt
    this.pairingPromptTimeout = setTimeout(() => {
      console.log('Pairing prompt timed out');
      stdin.removeListener('data', onKeyPress);
      stdin.setRawMode(false);
      stdin.pause();
    }, 60000); // 1 minute timeout
  }
}

// Create and start the target device
const targetDevice = new BunTargetDevice({
  autoConnect: true,
  autoAcceptPairing: process.env.AUTO_ACCEPT_PAIRING === 'true'
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT signal, shutting down...');
  targetDevice.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal, shutting down...');
  targetDevice.stop();
  process.exit(0);
});

// Start target device
targetDevice.start();

export default BunTargetDevice;
EOL

# Run the Bun-compatible target
echo "Starting Bun-compatible target device..."
echo "The target will try to connect to the controller at 127.0.0.1:8080 by default."
echo "To specify a different controller, set the CONTROLLER_IP and WEBSOCKET_PORT environment variables."
echo ""
echo "For example: CONTROLLER_IP=192.168.1.40 WEBSOCKET_PORT=8080 bun src/target/bunTarget.ts"
echo ""

# Ask for controller IP
echo -n "Enter controller IP (default: 127.0.0.1): "
read controller_ip
controller_ip=${controller_ip:-127.0.0.1}

# Ask for controller port
echo -n "Enter controller port (default: 8080): "
read controller_port
controller_port=${controller_port:-8080}

# Run with the provided IP and port
CONTROLLER_IP=$controller_ip WEBSOCKET_PORT=$controller_port bun src/target/bunTarget.ts

echo "Done!"
