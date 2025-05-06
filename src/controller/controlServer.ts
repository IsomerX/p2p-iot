import * as WebSocket from "ws";
import * as http from "http";
import { EventEmitter } from "events";
import {
  MESSAGE_TYPES,
  COMMAND_TYPES,
  DEFAULT_WEBSOCKET_PORT,
  ERROR_CODES,
  WS_PING_INTERVAL,
} from "../shared/constants";
import {
  DeviceType,
  ConnectionStatus,
  type ProtocolMessage,
  type CommandMessage,
  type ArrowCommandParameters,
} from "../shared/types";
import {
  createBaseMessage,
  createErrorMessage,
  validateMessage,
  parseJsonMessage,
  createLogger,
} from "../shared/utils";
import { DeviceRegistry } from "./deviceRegistry";

const logger = createLogger("ControlServer");

interface ControlServerOptions {
  port?: number;
  controllerId: string;
  deviceRegistry: DeviceRegistry;
}

interface WebSocketWithId extends WebSocket {
  connectionId: string;
  deviceId?: string;
  isAlive: boolean;
  lastActivity: number;
}

class ControlServer extends EventEmitter {
  private readonly options: Required<ControlServerOptions>;
  private server: http.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private connections: Map<string, WebSocketWithId> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly deviceRegistry: DeviceRegistry;
  private isRunning: boolean = false;

  constructor(options: ControlServerOptions) {
    super();
    this.options = {
      port: DEFAULT_WEBSOCKET_PORT,
      ...options,
    };
    this.deviceRegistry = options.deviceRegistry;
  }

  /**
   * Start the control server
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        logger.warn("Control server is already running");
        resolve();
        return;
      }

      try {
        // Create HTTP server
        this.server = http.createServer();

        // Create WebSocket server
        this.wss = new WebSocket.Server({ server: this.server });

        // Set up connection handler
        this.wss.on("connection", this.handleConnection.bind(this));

        // Set up error handler
        this.wss.on("error", (error) => {
          logger.error("WebSocket server error", error);
          this.emit("error", error);
        });

        // Start HTTP server
        this.server.listen(this.options.port, () => {
          logger.info(`Control server listening on port ${this.options.port}`);
          this.isRunning = true;

          // Start ping interval
          this.pingInterval = setInterval(() => {
            this.pingConnections();
          }, WS_PING_INTERVAL);

          resolve();
        });

        // Handle server error
        this.server.on("error", (error) => {
          logger.error("HTTP server error", error);
          this.emit("error", error);
          reject(error);
        });
      } catch (error) {
        logger.error("Error starting control server", error);
        reject(error);
      }
    });
  }

  /**
   * Stop the control server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        logger.warn("Control server is not running");
        resolve();
        return;
      }

      // Clear ping interval
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      // Close all connections
      for (const connection of this.connections.values()) {
        connection.terminate();
      }
      this.connections.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP server
          if (this.server) {
            this.server.close(() => {
              logger.info("Control server stopped");
              this.isRunning = false;
              resolve();
            });
          } else {
            this.isRunning = false;
            resolve();
          }
        });
      } else if (this.server) {
        this.server.close(() => {
          logger.info("Control server stopped");
          this.isRunning = false;
          resolve();
        });
      } else {
        this.isRunning = false;
        resolve();
      }
    });
  }

  /**
   * Send an arrow command to a device
   */
  public sendArrowCommand(
    deviceId: string,
    direction: "left" | "right",
    options: { repeat?: number; holdTime?: number } = {},
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Get device
      const device = this.deviceRegistry.getDeviceById(deviceId);
      if (!device) {
        logger.error(`Device not found: ${deviceId}`);
        reject(new Error("Device not found"));
        return;
      }

      // Check if device is connected
      if (
        device.status !== ConnectionStatus.CONNECTED &&
        device.status !== ConnectionStatus.PAIRED
      ) {
        logger.error(`Device not connected: ${deviceId}`);
        reject(new Error("Device not connected"));
        return;
      }

      // Check if device is paired if needed
      if (!device.paired) {
        logger.error(`Device not paired: ${deviceId}`);
        reject(new Error("Device not paired"));
        return;
      }

      // Check if device supports arrow commands
      const commandType =
        direction === "left"
          ? COMMAND_TYPES.ARROW_LEFT
          : COMMAND_TYPES.ARROW_RIGHT;
      if (!device.deviceInfo.supportedCommands.includes(commandType)) {
        logger.error(`Device does not support command: ${commandType}`);
        reject(new Error(`Device does not support command: ${commandType}`));
        return;
      }

      // Get connection
      const connection = this.getConnectionByDeviceId(deviceId);
      if (!connection) {
        logger.error(`No active connection for device: ${deviceId}`);
        reject(new Error("No active connection for device"));
        return;
      }

      // Create command message
      const commandMessage: CommandMessage = {
        ...createBaseMessage(
          MESSAGE_TYPES.COMMAND,
          this.options.controllerId,
          DeviceType.CONTROLLER,
        ),
        data: {
          commandType,
          parameters: {
            direction,
            repeat: options.repeat || 1,
            holdTime: options.holdTime || 0,
          } as ArrowCommandParameters,
        },
      };

      // Send command
      this.sendMessage(connection, commandMessage)
        .then(() => {
          logger.debug(
            `Sent ${direction} arrow command to device: ${deviceId}`,
          );
          resolve(true);
        })
        .catch((error) => {
          logger.error(`Error sending command to device: ${deviceId}`, error);
          reject(error);
        });
    });
  }

  /**
   * Get a connection by device ID
   */
  private getConnectionByDeviceId(
    deviceId: string,
  ): WebSocketWithId | undefined {
    for (const connection of this.connections.values()) {
      if (connection.deviceId === deviceId) {
        return connection;
      }
    }
    return undefined;
  }

  /**
   * Handle a new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Initialize connection
    const connectionId =
      Date.now().toString() + Math.random().toString().substring(2);
    const connection = ws as WebSocketWithId;
    connection.connectionId = connectionId;
    connection.isAlive = true;
    connection.lastActivity = Date.now();

    // Get client IP
    const ip = req.socket.remoteAddress || "unknown";
    logger.info(`New connection from ${ip} (${connectionId})`);

    // Store connection
    this.connections.set(connectionId, connection);

    // Set up message handler
    connection.on("message", (data: WebSocket.Data) => {
      connection.lastActivity = Date.now();
      this.handleMessage(connection, data);
    });

    // Set up close handler
    connection.on("close", () => {
      this.handleClose(connection);
    });

    // Set up error handler
    connection.on("error", (error) => {
      logger.error(`Connection error (${connectionId})`, error);
      this.emit("connectionError", { connectionId, error });
    });

    // Set up pong handler
    connection.on("pong", () => {
      connection.isAlive = true;
      connection.lastActivity = Date.now();
    });

    // Emit connection event
    this.emit("connection", { connectionId, ip });
  }

  /**
   * Handle a message from a connection
   */
  private handleMessage(
    connection: WebSocketWithId,
    data: WebSocket.Data,
  ): void {
    try {
      // Parse message
      const { valid, message, error } = parseJsonMessage(data.toString());
      if (!valid || !message) {
        logger.warn(
          `Invalid message from connection (${connection.connectionId}): ${error}`,
        );
        this.sendMessage(
          connection,
          createErrorMessage(
            this.options.controllerId,
            DeviceType.CONTROLLER,
            ERROR_CODES.INVALID_MESSAGE,
            "Invalid message format",
          ),
        );
        return;
      }

      // Validate message
      const validation = validateMessage(message);
      if (!validation.valid) {
        logger.warn(
          `Invalid message from connection (${connection.connectionId}): ${validation.error}`,
        );
        this.sendMessage(
          connection,
          createErrorMessage(
            this.options.controllerId,
            DeviceType.CONTROLLER,
            ERROR_CODES.INVALID_MESSAGE,
            validation.error,
          ),
        );
        return;
      }

      // Handle message based on type
      switch (message.type) {
        case MESSAGE_TYPES.REGISTER:
          this.handleRegisterMessage(connection, message as ProtocolMessage);
          break;
        case MESSAGE_TYPES.PAIRING_REQUEST:
          this.handlePairingRequestMessage(
            connection,
            message as ProtocolMessage,
          );
          break;
        case MESSAGE_TYPES.COMMAND_RESULT:
          this.handleCommandResultMessage(
            connection,
            message as ProtocolMessage,
          );
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeatMessage(connection, message as ProtocolMessage);
          break;
        default:
          logger.warn(`Unhandled message type: ${message.type}`);
          this.sendMessage(
            connection,
            createErrorMessage(
              this.options.controllerId,
              DeviceType.CONTROLLER,
              ERROR_CODES.INVALID_MESSAGE,
              `Unsupported message type: ${message.type}`,
            ),
          );
      }
    } catch (error) {
      logger.error(
        `Error handling message from connection (${connection.connectionId})`,
        error,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.INTERNAL_ERROR,
          "Internal server error",
        ),
      );
    }
  }

  /**
   * Handle a register message
   */
  private handleRegisterMessage(
    connection: WebSocketWithId,
    message: ProtocolMessage,
  ): void {
    // Extract device info
    const { deviceInfo } = (message as any).data;
    if (!deviceInfo || !deviceInfo.id || !deviceInfo.type) {
      logger.warn(
        `Invalid register message from connection (${connection.connectionId})`,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.INVALID_MESSAGE,
          "Invalid device info",
        ),
      );
      return;
    }

    // Check device type
    if (deviceInfo.type !== DeviceType.TARGET) {
      logger.warn(
        `Invalid device type in register message: ${deviceInfo.type}`,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.INVALID_MESSAGE,
          "Only target devices can register",
        ),
      );
      return;
    }

    // Register device
    const device = this.deviceRegistry.registerDevice(deviceInfo);

    // Associate connection with device
    connection.deviceId = device.deviceInfo.id;

    // Connect device
    this.deviceRegistry.connectDevice(
      device.deviceInfo.id,
      connection.connectionId,
    );

    // Send registered message
    const registeredMessage: ProtocolMessage = {
      ...createBaseMessage(
        MESSAGE_TYPES.REGISTERED,
        this.options.controllerId,
        DeviceType.CONTROLLER,
      ),
      data: {
        deviceId: device.deviceInfo.id,
        pairingRequired: !device.paired,
        pairingToken: device.pairingToken,
      },
    };
    this.sendMessage(connection, registeredMessage);

    logger.info(
      `Device registered: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
    );
    this.emit("deviceRegistered", device);
  }

  /**
   * Handle a pairing request message
   */
  private handlePairingRequestMessage(
    connection: WebSocketWithId,
    message: ProtocolMessage,
  ): void {
    // Check if connection is associated with a device
    if (!connection.deviceId) {
      logger.warn(
        `Pairing request from unregistered connection (${connection.connectionId})`,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.INVALID_MESSAGE,
          "Device not registered",
        ),
      );
      return;
    }

    // Extract pairing token
    const { pairingToken } = (message as any).data;
    if (!pairingToken) {
      logger.warn(
        `Invalid pairing request from connection (${connection.connectionId})`,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.INVALID_MESSAGE,
          "Missing pairing token",
        ),
      );
      return;
    }

    // Pair device
    const result = this.deviceRegistry.pairDevice(
      connection.deviceId,
      pairingToken,
    );
    if (!result.success) {
      logger.warn(
        `Pairing failed for device (${connection.deviceId}): ${result.error}`,
      );
      this.sendMessage(
        connection,
        createErrorMessage(
          this.options.controllerId,
          DeviceType.CONTROLLER,
          ERROR_CODES.AUTHENTICATION_FAILED,
          result.error || "Pairing failed",
        ),
      );
      return;
    }

    // Send pairing response
    const pairingResponseMessage: ProtocolMessage = {
      ...createBaseMessage(
        MESSAGE_TYPES.PAIRING_RESPONSE,
        this.options.controllerId,
        DeviceType.CONTROLLER,
      ),
      data: {
        accepted: true,
        authToken: result.device?.authToken,
      },
    };
    this.sendMessage(connection, pairingResponseMessage);

    logger.info(
      `Device paired: ${result.device?.deviceInfo.name} (${connection.deviceId})`,
    );
    this.emit("devicePaired", result.device);
  }

  /**
   * Handle a command result message
   */
  private handleCommandResultMessage(
    connection: WebSocketWithId,
    message: ProtocolMessage,
  ): void {
    // Check if connection is associated with a device
    if (!connection.deviceId) {
      logger.warn(
        `Command result from unregistered connection (${connection.connectionId})`,
      );
      return;
    }

    // Extract command result
    const { commandType, success, error, result } = (message as any).data;
    if (!commandType) {
      logger.warn(
        `Invalid command result from connection (${connection.connectionId})`,
      );
      return;
    }

    // Get device
    const device = this.deviceRegistry.getDeviceById(connection.deviceId);
    if (!device) {
      logger.warn(
        `Command result from unknown device (${connection.deviceId})`,
      );
      return;
    }

    // Emit command result event
    this.emit("commandResult", {
      device,
      commandType,
      success,
      error,
      result,
    });

    logger.debug(
      `Command result from device ${device.deviceInfo.name}: ${commandType} ${success ? "succeeded" : "failed"}`,
    );
  }

  /**
   * Handle a heartbeat message
   */
  private handleHeartbeatMessage(
    connection: WebSocketWithId,
    message: ProtocolMessage,
  ): void {
    // Update connection status
    connection.isAlive = true;
    connection.lastActivity = Date.now();

    // Update device last seen
    if (connection.deviceId) {
      this.deviceRegistry.updateDeviceLastSeen(connection.deviceId);
    }

    // Send heartbeat acknowledgement
    const heartbeatAckMessage: ProtocolMessage = {
      ...createBaseMessage(
        MESSAGE_TYPES.HEARTBEAT_ACK,
        this.options.controllerId,
        DeviceType.CONTROLLER,
      ),
      data: {},
    };
    this.sendMessage(connection, heartbeatAckMessage);
  }

  /**
   * Handle a connection close
   */
  private handleClose(connection: WebSocketWithId): void {
    logger.info(`Connection closed (${connection.connectionId})`);

    // Disconnect device if associated
    if (connection.deviceId) {
      this.deviceRegistry.disconnectDevice(connection.deviceId);
    }

    // Remove connection
    this.connections.delete(connection.connectionId);

    // Emit close event
    this.emit("connectionClosed", {
      connectionId: connection.connectionId,
      deviceId: connection.deviceId,
    });
  }

  /**
   * Ping all connections to check if they are still alive
   */
  private pingConnections(): void {
    const currentTime = Date.now();

    for (const connection of this.connections.values()) {
      if (!connection.isAlive) {
        logger.warn(
          `Connection not responding (${connection.connectionId}), terminating`,
        );
        connection.terminate();
        continue;
      }

      // Reset alive flag
      connection.isAlive = false;

      // Send ping
      try {
        connection.ping();
      } catch (error) {
        logger.error(
          `Error sending ping to connection (${connection.connectionId})`,
          error,
        );
        connection.terminate();
      }
    }
  }

  /**
   * Send a message to a connection
   */
  private sendMessage(
    connection: WebSocketWithId,
    message: ProtocolMessage,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const messageData = JSON.stringify(message);
        connection.send(messageData, (error) => {
          if (error) {
            logger.error(
              `Error sending message to connection (${connection.connectionId})`,
              error,
            );
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        logger.error(`Error serializing message`, error);
        reject(error);
      }
    });
  }
}

export default ControlServer;
