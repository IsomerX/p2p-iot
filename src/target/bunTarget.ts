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
