// Save as src/target/directTarget.ts
import * as dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
// Fix the WebSocket import
import WebSocket from "ws";
import {
  DEFAULT_WEBSOCKET_PORT,
  MESSAGE_TYPES,
  COMMAND_TYPES,
  WS_PING_INTERVAL,
} from "../shared/constants";
import {
  DeviceType,
  ConnectionStatus,
  type ArrowCommandParameters,
} from "../shared/types";
import { createBaseMessage, createLogger } from "../shared/utils";
import { EventEmitter } from "events";
import { type MockKeySimulator } from "./mockKeySimulator";

// Setup logger
const logger = createLogger("DirectTarget");

// Mock key simulator (copy the implementation from your mockKeySimulator.ts)
class MockKeySimulator {
  private readonly verbose: boolean;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose || false;
    logger.info(
      "Using mock key simulator - key presses will be logged but not actually simulated",
    );
  }

  public async pressLeftArrow(
    options: { repeat?: number; holdTime?: number } = {},
  ): Promise<boolean> {
    return this.pressKey("left", options);
  }

  public async pressRightArrow(
    options: { repeat?: number; holdTime?: number } = {},
  ): Promise<boolean> {
    return this.pressKey("right", options);
  }

  public async pressKey(
    key: string,
    options: { repeat?: number; holdTime?: number } = {},
  ): Promise<boolean> {
    const repeat = options.repeat || 1;
    const holdTime = options.holdTime || 0;

    logger.info(
      `MOCK: Simulating key press: ${key} (repeat: ${repeat}, holdTime: ${holdTime}ms)`,
    );

    if (this.verbose) {
      for (let i = 0; i < repeat; i++) {
        logger.info(`MOCK: Press ${i + 1}/${repeat}: ${key}`);
        if (holdTime > 0) {
          logger.info(`MOCK: Holding ${key} for ${holdTime}ms`);
        }
      }
    }

    return true;
  }
}

// Direct connection client
class DirectConnectionClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private status = ConnectionStatus.DISCONNECTED;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private pairingToken?: string;

  constructor(
    private readonly deviceId: string,
    private readonly deviceName: string,
    private readonly controllerIp: string,
    private readonly controllerPort: number,
    private readonly supportedCommands: string[],
    private readonly onArrowCommand: (
      direction: "left" | "right",
      options: { repeat: number; holdTime: number },
    ) => Promise<boolean>,
  ) {
    super();
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public async connect(): Promise<boolean> {
    if (this.ws) {
      logger.warn("Already connected to controller");
      return false;
    }

    try {
      logger.info(
        `Connecting to controller at ${this.controllerIp}:${this.controllerPort}`,
      );
      this.status = ConnectionStatus.CONNECTING;
      this.emit("statusChanged", this.status);

      this.ws = new WebSocket(
        `ws://${this.controllerIp}:${this.controllerPort}`,
      );

      this.ws.on("open", () => {
        logger.info("Connected to controller!");
        this.status = ConnectionStatus.CONNECTED;
        this.emit("statusChanged", this.status);

        // Register device
        this.sendRegistration();

        // Start heartbeat
        this.startHeartbeat();

        // Reset reconnect attempts
        this.reconnectAttempts = 0;
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        logger.error("WebSocket error", error);
        this.handleDisconnection();
      });

      this.ws.on("close", () => {
        logger.info("Disconnected from controller");
        this.handleDisconnection();
      });

      return true;
    } catch (error) {
      logger.error("Error connecting to controller", error);
      this.handleDisconnection();
      return false;
    }
  }

  public disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
        this.ws = null;
      } catch (error) {
        logger.error("Error closing WebSocket", error);
      }
    }

    this.status = ConnectionStatus.DISCONNECTED;
    this.emit("statusChanged", this.status);
    logger.info("Disconnected from controller");
  }

  public sendPairingRequest(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.error("Cannot send pairing request: WebSocket not connected");
        reject(new Error("Not connected to controller"));
        return;
      }

      if (!this.pairingToken) {
        logger.error("Cannot send pairing request: No pairing token available");
        reject(new Error("No pairing token available"));
        return;
      }

      try {
        // Create pairing request message
        const message = {
          ...createBaseMessage(
            MESSAGE_TYPES.PAIRING_REQUEST,
            this.deviceId,
            DeviceType.TARGET,
          ),
          data: {
            pairingToken: this.pairingToken,
          },
        };

        // Send message
        this.ws.send(JSON.stringify(message));
        logger.info("Sent pairing request");

        // We'll get the response asynchronously via handleMessage
        // The promise will be resolved/rejected there
        this.once(
          "pairingResult",
          (result: { success: boolean; error?: string }) => {
            if (result.success) {
              resolve(true);
            } else {
              reject(new Error(result.error || "Pairing failed"));
            }
          },
        );
      } catch (error) {
        logger.error("Error sending pairing request", error);
        reject(error);
      }
    });
  }

  private sendRegistration(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Cannot register device: WebSocket not connected");
      return;
    }

    try {
      // Create registration message
      const message = {
        ...createBaseMessage(
          MESSAGE_TYPES.REGISTER,
          this.deviceId,
          DeviceType.TARGET,
        ),
        data: {
          deviceInfo: {
            id: this.deviceId,
            name: this.deviceName,
            ip: "127.0.0.1", // Local IP doesn't matter for direct connection
            type: DeviceType.TARGET,
            supportedCommands: this.supportedCommands,
          },
        },
      };

      // Send message
      this.ws.send(JSON.stringify(message));
      logger.info("Sent device registration");
    } catch (error) {
      logger.error("Error sending registration", error);
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      // Create heartbeat message
      const message = {
        ...createBaseMessage(
          MESSAGE_TYPES.HEARTBEAT,
          this.deviceId,
          DeviceType.TARGET,
        ),
        data: {},
      };

      // Send message
      this.ws.send(JSON.stringify(message));
      logger.debug("Sent heartbeat");
    } catch (error) {
      logger.error("Error sending heartbeat", error);
    }
  }

  private sendCommandResult(
    commandType: string,
    success: boolean,
    error?: string,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Cannot send command result: WebSocket not connected");
      return;
    }

    try {
      // Create command result message
      const message = {
        ...createBaseMessage(
          MESSAGE_TYPES.COMMAND_RESULT,
          this.deviceId,
          DeviceType.TARGET,
        ),
        data: {
          commandType,
          success,
          error,
        },
      };

      // Send message
      this.ws.send(JSON.stringify(message));
      logger.debug(
        `Sent command result: ${commandType} ${success ? "succeeded" : "failed"}`,
      );
    } catch (error) {
      logger.error("Error sending command result", error);
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const dataStr = typeof data === "string" ? data : data.toString();
      const message = JSON.parse(dataStr);
      logger.debug(`Received message: ${message.type}`);

      // Handle different message types
      switch (message.type) {
        case MESSAGE_TYPES.REGISTERED:
          this.handleRegisteredMessage(message);
          break;
        case MESSAGE_TYPES.PAIRING_RESPONSE:
          this.handlePairingResponseMessage(message);
          break;
        case MESSAGE_TYPES.COMMAND:
          this.handleCommandMessage(message);
          break;
        case MESSAGE_TYPES.HEARTBEAT_ACK:
          logger.debug("Received heartbeat acknowledgement");
          break;
        default:
          logger.warn(`Unhandled message type: ${message.type}`);
      }
    } catch (error) {
      logger.error("Error handling message", error);
    }
  }

  private handleRegisteredMessage(message: any): void {
    const { deviceId, pairingRequired, pairingToken } = message.data;

    if (deviceId !== this.deviceId) {
      logger.warn(`Received registration for different device ID: ${deviceId}`);
      return;
    }

    logger.info(
      `Device registered with controller ${pairingRequired ? "(pairing required)" : "(no pairing required)"}`,
    );

    // Update pairing status
    if (pairingRequired) {
      this.status = ConnectionStatus.CONNECTED;

      // Store pairing token for later use
      this.pairingToken = pairingToken;

      // Emit pairing required event
      this.emit("pairingRequired", pairingToken);
    } else {
      this.status = ConnectionStatus.PAIRED;

      // Emit registered event
      this.emit("registered");
    }

    // Emit status change
    this.emit("statusChanged", this.status);
  }

  private handlePairingResponseMessage(message: any): void {
    const { accepted, error } = message.data;

    if (accepted) {
      logger.info("Pairing accepted");

      // Update status
      this.status = ConnectionStatus.PAIRED;
      this.emit("statusChanged", this.status);

      // Emit pairing result event
      this.emit("pairingResult", { success: true });
    } else {
      logger.warn(`Pairing rejected: ${error}`);

      // Emit pairing result event
      this.emit("pairingResult", { success: false, error });
    }
  }

  private async handleCommandMessage(message: any): Promise<void> {
    const { commandType, parameters } = message.data;

    // Check if command is supported
    if (!this.supportedCommands.includes(commandType)) {
      logger.warn(`Received unsupported command: ${commandType}`);
      this.sendCommandResult(commandType, false, "Unsupported command");
      return;
    }

    // Handle arrow commands
    if (
      commandType === COMMAND_TYPES.ARROW_LEFT ||
      commandType === COMMAND_TYPES.ARROW_RIGHT
    ) {
      const direction =
        commandType === COMMAND_TYPES.ARROW_LEFT ? "left" : "right";
      const options = {
        repeat: (parameters as ArrowCommandParameters)?.repeat || 1,
        holdTime: (parameters as ArrowCommandParameters)?.holdTime || 0,
      };

      try {
        logger.info(
          `Executing arrow command: ${direction} (repeat: ${options.repeat}, holdTime: ${options.holdTime}ms)`,
        );

        // Execute arrow command
        const success = await this.onArrowCommand(direction, options);

        if (success) {
          logger.info(`Arrow command executed successfully: ${direction}`);
          this.sendCommandResult(commandType, true);
        } else {
          logger.warn(`Arrow command execution failed: ${direction}`);
          this.sendCommandResult(
            commandType,
            false,
            "Command execution failed",
          );
        }

        // Emit command event
        this.emit("command", {
          type: commandType,
          direction,
          options,
          success,
        });
      } catch (error) {
        logger.error(`Error executing arrow command: ${direction}`, error);
        this.sendCommandResult(commandType, false, "Internal error");
      }
    } else {
      logger.warn(`Unhandled command type: ${commandType}`);
      this.sendCommandResult(commandType, false, "Unhandled command");
    }
  }

  private handleDisconnection(): void {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Clear WebSocket
    this.ws = null;

    // Update status
    this.status = ConnectionStatus.DISCONNECTED;
    this.emit("statusChanged", this.status);

    // Attempt to reconnect
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Calculate backoff time
    const backoffTime = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      30000,
    );

    logger.info(`Scheduling reconnect attempt in ${backoffTime}ms`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;

      if (this.reconnectAttempts > this.maxReconnectAttempts) {
        logger.warn("Max reconnect attempts reached, giving up");
        return;
      }

      logger.info(`Reconnect attempt ${this.reconnectAttempts}`);
      this.connect().catch((error) => {
        logger.error("Reconnect attempt failed", error);
      });
    }, backoffTime);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, WS_PING_INTERVAL);

    // Send initial heartbeat
    this.sendHeartbeat();
  }
}

// Main target class
class DirectTarget {
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly client: DirectConnectionClient;
  private readonly keySimulator: MockKeySimulator;
  private pairingPromptTimeout: NodeJS.Timeout | null = null;

  constructor() {
    // Get configuration from environment variables or use defaults
    this.deviceId = process.env.DEVICE_ID || uuidv4();
    this.deviceName =
      process.env.DEVICE_NAME || `ArrowTarget-${Date.now().toString(36)}`;
    const controllerIp = process.env.CONTROLLER_IP || "192.168.1.40"; // Use the actual controller IP
    const controllerPort =
      Number(process.env.CONTROLLER_PORT) || DEFAULT_WEBSOCKET_PORT;
    const autoAcceptPairing = process.env.AUTO_ACCEPT_PAIRING === "true";

    // Initialize key simulator
    this.keySimulator = new MockKeySimulator({
      verbose: process.env.KEY_SIMULATOR_VERBOSE === "true",
    });

    // Initialize client
    this.client = new DirectConnectionClient(
      this.deviceId,
      this.deviceName,
      controllerIp,
      controllerPort,
      [COMMAND_TYPES.ARROW_LEFT, COMMAND_TYPES.ARROW_RIGHT],
      this.handleArrowCommand.bind(this),
    );

    // Set up event handlers
    this.setupEventHandlers(autoAcceptPairing);
  }

  public async start(): Promise<void> {
    logger.info(
      `Starting direct target: ${this.deviceName} (${this.deviceId})`,
    );
    logger.info(
      `Controller: ${process.env.CONTROLLER_IP || "192.168.1.40"}:${process.env.CONTROLLER_PORT || DEFAULT_WEBSOCKET_PORT}`,
    );

    try {
      await this.client.connect();
    } catch (error) {
      logger.error("Failed to connect to controller", error);
    }
  }

  public stop(): void {
    logger.info("Stopping direct target");

    // Clear pairing prompt timeout
    if (this.pairingPromptTimeout) {
      clearTimeout(this.pairingPromptTimeout);
      this.pairingPromptTimeout = null;
    }

    // Disconnect client
    this.client.disconnect();

    logger.info("Direct target stopped");
  }

  private setupEventHandlers(autoAcceptPairing: boolean): void {
    // Status changes
    this.client.on("statusChanged", (status) => {
      logger.info(`Connection status changed: ${status}`);
    });

    // Pairing events
    this.client.on("pairingRequired", (pairingToken) => {
      logger.info("Pairing required");

      if (autoAcceptPairing) {
        logger.info("Auto-accepting pairing request");
        this.client.sendPairingRequest().catch((error) => {
          logger.error("Error auto-accepting pairing", error);
        });
      } else {
        // Display pairing prompt
        this.showPairingPrompt(pairingToken);
      }
    });

    this.client.on("pairingResult", (result) => {
      if (result.success) {
        logger.info("Pairing successful");
      } else {
        logger.warn(`Pairing failed: ${result.error}`);
      }
    });

    // Command events
    this.client.on("command", (command) => {
      logger.info(
        `Executed command: ${command.type} (success: ${command.success})`,
      );
    });
  }

  private async handleArrowCommand(
    direction: "left" | "right",
    options: { repeat: number; holdTime: number },
  ): Promise<boolean> {
    logger.info(
      `Received ${direction} arrow command (repeat: ${options.repeat}, holdTime: ${options.holdTime}ms)`,
    );

    // Execute the key press
    let success = false;
    if (direction === "left") {
      success = await this.keySimulator.pressLeftArrow(options);
    } else if (direction === "right") {
      success = await this.keySimulator.pressRightArrow(options);
    }

    return success;
  }

  private showPairingPrompt(pairingToken: string): void {
    // Clear any existing prompt timeout
    if (this.pairingPromptTimeout) {
      clearTimeout(this.pairingPromptTimeout);
    }

    // Display pairing information
    console.log("\n========================================");
    console.log("           PAIRING REQUIRED            ");
    console.log("========================================");
    console.log(`Device: ${this.deviceName}`);
    console.log(`Pairing Token: ${pairingToken}`);
    console.log("");
    console.log("To accept the pairing request, press:");
    console.log("  Y - Accept pairing");
    console.log("  N - Reject pairing");
    console.log("========================================\n");

    // Set up keyboard input handling for the prompt
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onKeyPress = (key: string) => {
      // Handle user input
      if (key.toLowerCase() === "y") {
        // Accept pairing
        console.log("Accepting pairing request...");
        stdin.removeListener("data", onKeyPress);
        stdin.setRawMode(false);
        stdin.pause();

        this.client.sendPairingRequest().catch((error) => {
          logger.error("Error accepting pairing", error);
        });
      } else if (key.toLowerCase() === "n") {
        // Reject pairing
        console.log("Rejecting pairing request...");
        stdin.removeListener("data", onKeyPress);
        stdin.setRawMode(false);
        stdin.pause();
      } else if (key === "\u0003") {
        // Handle Ctrl+C
        process.exit();
      }
    };

    // Listen for key presses
    stdin.on("data", onKeyPress);

    // Set timeout for the prompt
    this.pairingPromptTimeout = setTimeout(() => {
      console.log("Pairing prompt timed out");
      stdin.removeListener("data", onKeyPress);
      stdin.setRawMode(false);
      stdin.pause();
    }, 60000); // 1 minute timeout
  }
}

// Load environment variables
dotenv.config();

// Create and start the direct target
const target = new DirectTarget();

// Handle graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT signal, shutting down...");
  target.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal, shutting down...");
  target.stop();
  process.exit(0);
});

// Start target
target.start().catch((error) => {
  logger.error("Failed to start target", error);
});
