import find from "local-devices";
import { EventEmitter } from "events";
import * as dgram from "dgram";
import {
  DEVICE_SCAN_INTERVAL,
  DEFAULT_DISCOVERY_PORT,
  MESSAGE_TYPES,
} from "../shared/constants";
import {
  createBaseMessage,
  createLogger,
  getLocalIpAddress,
} from "../shared/utils";
import {
  DeviceType,
  type AnnounceMessage,
  type DeviceInfo,
} from "../shared/types";

const logger = createLogger("NetworkScanner");

interface NetworkScannerOptions {
  deviceScanInterval?: number;
  discoveryPort?: number;
  controllerId: string;
  controllerName: string;
  supportedCommands: string[];
  controlPort: number;
}

interface DiscoveredDevice {
  ip: string;
  mac?: string;
  name?: string;
  lastSeen: number;
}

class NetworkScanner extends EventEmitter {
  private readonly options: Required<NetworkScannerOptions>;
  private readonly discoveredDevices: Map<string, DiscoveredDevice> = new Map();
  private scanIntervalId: NodeJS.Timeout | null = null;
  private broadcastSocket: dgram.Socket | null = null;
  private controllerInfo: DeviceInfo;
  private isScanning: boolean = false;

  constructor(options: NetworkScannerOptions) {
    super();
    this.options = {
      deviceScanInterval: DEVICE_SCAN_INTERVAL,
      discoveryPort: DEFAULT_DISCOVERY_PORT,
      ...options,
    };

    // Create controller info object
    this.controllerInfo = {
      id: this.options.controllerId,
      name: this.options.controllerName,
      ip: getLocalIpAddress() || "127.0.0.1",
      type: DeviceType.CONTROLLER,
      supportedCommands: this.options.supportedCommands,
    };
  }

  /**
   * Start scanning the network
   */
  public start(): void {
    if (this.isScanning) {
      logger.warn("Network scanner is already running");
      return;
    }

    this.isScanning = true;
    logger.info("Starting network scanner");

    // Start device scanning
    this.scanNetwork();
    this.scanIntervalId = setInterval(() => {
      this.scanNetwork();
    }, this.options.deviceScanInterval);

    // Setup broadcast socket for discovery
    this.setupBroadcastSocket();
  }

  /**
   * Stop scanning the network
   */
  public stop(): void {
    if (!this.isScanning) {
      logger.warn("Network scanner is not running");
      return;
    }

    logger.info("Stopping network scanner");

    // Clear scan interval
    if (this.scanIntervalId) {
      clearInterval(this.scanIntervalId);
      this.scanIntervalId = null;
    }

    // Close broadcast socket
    if (this.broadcastSocket) {
      this.broadcastSocket.close();
      this.broadcastSocket = null;
    }

    this.isScanning = false;
  }

  /**
   * Get all discovered devices
   */
  public getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values());
  }

  /**
   * Send a broadcast announcement to discover devices
   */
  public sendBroadcastAnnouncement(): void {
    if (!this.broadcastSocket) {
      logger.error("Broadcast socket not initialized");
      return;
    }

    try {
      // Create announcement message
      const message: AnnounceMessage = {
        ...createBaseMessage(
          MESSAGE_TYPES.ANNOUNCE,
          this.controllerInfo.id,
          DeviceType.CONTROLLER,
        ),
        data: {
          controllerInfo: this.controllerInfo,
          discoveryPort: this.options.discoveryPort,
          controlPort: this.options.controlPort,
        },
      };

      // Convert message to buffer
      const messageBuffer = Buffer.from(JSON.stringify(message));

      // Send broadcast message
      this.broadcastSocket.send(
        messageBuffer,
        0,
        messageBuffer.length,
        this.options.discoveryPort,
        "255.255.255.255",
        (err) => {
          if (err) {
            logger.error("Error sending broadcast announcement", err);
          } else {
            logger.debug("Sent broadcast announcement");
          }
        },
      );
    } catch (error) {
      logger.error("Error creating broadcast announcement", error);
    }
  }

  /**
   * Scan the network for devices
   */
  private async scanNetwork(): Promise<void> {
    try {
      logger.debug("Scanning network for devices");

      // Find devices on the network
      const devices = await find();

      // Process discovered devices
      const currentTime = Date.now();
      devices.forEach((device) => {
        const { ip, mac = "", name = "" } = device;

        // Store or update device
        this.discoveredDevices.set(ip, {
          ip,
          mac,
          name: name !== "?" ? name : undefined,
          lastSeen: currentTime,
        });

        // Emit new device event if it's the first time we've seen this device
        if (!this.discoveredDevices.has(ip)) {
          this.emit("newDevice", { ip, mac, name });
        }
      });

      // Emit updated devices event
      this.emit("devicesUpdated", this.getDiscoveredDevices());

      // Clean up old devices (not seen in the last 5 minutes)
      const expirationTime = currentTime - 5 * 60 * 1000;
      for (const [ip, device] of this.discoveredDevices.entries()) {
        if (device.lastSeen < expirationTime) {
          this.discoveredDevices.delete(ip);
          this.emit("deviceLost", { ip, mac: device.mac, name: device.name });
        }
      }

      // Send broadcast announcement after each scan
      this.sendBroadcastAnnouncement();
    } catch (error) {
      logger.error("Error scanning network", error);
    }
  }

  /**
   * Setup broadcast socket for discovery
   */
  private setupBroadcastSocket(): void {
    try {
      // Create UDP socket
      this.broadcastSocket = dgram.createSocket({
        type: "udp4",
        reuseAddr: true,
      });

      // Handle errors
      this.broadcastSocket.on("error", (err) => {
        logger.error("Broadcast socket error", err);
        this.broadcastSocket?.close();
      });

      // Handle incoming messages
      this.broadcastSocket.on("message", (msg, rinfo) => {
        try {
          // Parse message
          const data = JSON.parse(msg.toString());

          // Check if this is a valid protocol message
          if (data && data.type && data.version && data.sender) {
            logger.debug(`Received ${data.type} message from ${rinfo.address}`);

            // Process message based on type
            if (
              data.type === MESSAGE_TYPES.REGISTER &&
              data.sender.type === DeviceType.TARGET
            ) {
              this.emit("deviceRegistration", {
                ip: rinfo.address,
                deviceInfo: data.data.deviceInfo,
              });
            }
          }
        } catch (error) {
          logger.error("Error processing broadcast message", error);
        }
      });

      // Bind to discovery port
      this.broadcastSocket.bind(this.options.discoveryPort, () => {
        // Enable broadcast
        this.broadcastSocket?.setBroadcast(true);
        logger.info(
          `Listening for devices on port ${this.options.discoveryPort}`,
        );

        // Send initial announcement
        this.sendBroadcastAnnouncement();
      });
    } catch (error) {
      logger.error("Error setting up broadcast socket", error);
    }
  }
}

export default NetworkScanner;
