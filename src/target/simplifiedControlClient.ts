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
