import { EventEmitter } from "events";
import { type DeviceInfo, ConnectionStatus } from "../shared/types";
import { generateToken, createLogger } from "../shared/utils";

const logger = createLogger("DeviceRegistry");

export interface RegisteredDevice {
  deviceInfo: DeviceInfo;
  status: ConnectionStatus;
  lastSeen: number;
  firstSeen: number;
  connectionId?: string;
  authToken?: string;
  paired: boolean;
  pairingToken?: string;
  pairingExpiration?: number;
}

export class DeviceRegistry extends EventEmitter {
  private devices: Map<string, RegisteredDevice> = new Map();
  private ipToIdMap: Map<string, string> = new Map();
  private macToIdMap: Map<string, string> = new Map();

  /**
   * Register a new device or update an existing one
   */
  public registerDevice(
    deviceInfo: DeviceInfo,
    requirePairing: boolean = true,
  ): RegisteredDevice {
    // Check if device already exists by ID
    if (this.devices.has(deviceInfo.id)) {
      const device = this.devices.get(deviceInfo.id)!;

      // Update device info and last seen time
      device.deviceInfo = {
        ...device.deviceInfo,
        ...deviceInfo,
      };
      device.lastSeen = Date.now();

      logger.info(
        `Updated existing device: ${device.deviceInfo.name} (${device.deviceInfo.id})`,
      );
      this.emit("deviceUpdated", device);

      return device;
    }

    // Check if device exists by IP or MAC
    let existingId: string | undefined;

    if (deviceInfo.ip && this.ipToIdMap.has(deviceInfo.ip)) {
      existingId = this.ipToIdMap.get(deviceInfo.ip);
    } else if (deviceInfo.mac && this.macToIdMap.has(deviceInfo.mac)) {
      existingId = this.macToIdMap.get(deviceInfo.mac);
    }

    if (existingId && this.devices.has(existingId)) {
      const device = this.devices.get(existingId)!;

      // Update device ID to the new one
      this.devices.delete(existingId);
      if (device.deviceInfo.ip) {
        this.ipToIdMap.delete(device.deviceInfo.ip);
      }
      if (device.deviceInfo.mac) {
        this.macToIdMap.delete(device.deviceInfo.mac);
      }

      // Create updated device with new ID
      const updatedDevice: RegisteredDevice = {
        ...device,
        deviceInfo: {
          ...device.deviceInfo,
          ...deviceInfo,
        },
        lastSeen: Date.now(),
      };

      // Store device with new ID
      this.devices.set(deviceInfo.id, updatedDevice);
      if (deviceInfo.ip) {
        this.ipToIdMap.set(deviceInfo.ip, deviceInfo.id);
      }
      if (deviceInfo.mac) {
        this.macToIdMap.set(deviceInfo.mac, deviceInfo.id);
      }

      logger.info(
        `Updated existing device with new ID: ${updatedDevice.deviceInfo.name} (${updatedDevice.deviceInfo.id})`,
      );
      this.emit("deviceUpdated", updatedDevice);

      return updatedDevice;
    }

    // Create new device
    const now = Date.now();
    const newDevice: RegisteredDevice = {
      deviceInfo,
      status: ConnectionStatus.DISCONNECTED,
      lastSeen: now,
      firstSeen: now,
      paired: false,
      pairingToken: requirePairing ? generateToken() : undefined,
      pairingExpiration: requirePairing ? now + 5 * 60 * 1000 : undefined, // 5 minutes
    };

    // Store device
    this.devices.set(deviceInfo.id, newDevice);
    if (deviceInfo.ip) {
      this.ipToIdMap.set(deviceInfo.ip, deviceInfo.id);
    }
    if (deviceInfo.mac) {
      this.macToIdMap.set(deviceInfo.mac, deviceInfo.id);
    }

    logger.info(
      `Registered new device: ${newDevice.deviceInfo.name} (${newDevice.deviceInfo.id})`,
    );
    this.emit("deviceRegistered", newDevice);

    return newDevice;
  }

  /**
   * Mark a device as connected
   */
  public connectDevice(
    deviceId: string,
    connectionId: string,
  ): RegisteredDevice | null {
    if (!this.devices.has(deviceId)) {
      logger.warn(`Cannot connect unknown device: ${deviceId}`);
      return null;
    }

    const device = this.devices.get(deviceId)!;

    // Update device status and connection ID
    device.status = device.paired
      ? ConnectionStatus.PAIRED
      : ConnectionStatus.CONNECTED;
    device.connectionId = connectionId;
    device.lastSeen = Date.now();

    logger.info(`Device connected: ${device.deviceInfo.name} (${deviceId})`);
    this.emit("deviceConnected", device);

    return device;
  }

  /**
   * Mark a device as disconnected
   */
  public disconnectDevice(deviceId: string): RegisteredDevice | null {
    if (!this.devices.has(deviceId)) {
      logger.warn(`Cannot disconnect unknown device: ${deviceId}`);
      return null;
    }

    const device = this.devices.get(deviceId)!;

    // Update device status and remove connection ID
    device.status = ConnectionStatus.DISCONNECTED;
    device.connectionId = undefined;
    device.lastSeen = Date.now();

    logger.info(`Device disconnected: ${device.deviceInfo.name} (${deviceId})`);
    this.emit("deviceDisconnected", device);

    return device;
  }

  /**
   * Mark a device as paired
   */
  public pairDevice(
    deviceId: string,
    pairingToken: string,
  ): { success: boolean; device?: RegisteredDevice; error?: string } {
    if (!this.devices.has(deviceId)) {
      logger.warn(`Cannot pair unknown device: ${deviceId}`);
      return { success: false, error: "Device not found" };
    }

    const device = this.devices.get(deviceId)!;

    // Check if device has a pairing token
    if (!device.pairingToken) {
      return { success: false, error: "Device does not support pairing" };
    }

    // Check if pairing token matches
    if (device.pairingToken !== pairingToken) {
      logger.warn(`Invalid pairing token for device: ${deviceId}`);
      return { success: false, error: "Invalid pairing token" };
    }

    // Check if pairing token has expired
    if (device.pairingExpiration && device.pairingExpiration < Date.now()) {
      logger.warn(`Pairing token expired for device: ${deviceId}`);
      return { success: false, error: "Pairing token expired" };
    }

    // Generate auth token
    device.authToken = generateToken();
    device.paired = true;
    device.pairingToken = undefined;
    device.pairingExpiration = undefined;

    // Update status if connected
    if (device.status === ConnectionStatus.CONNECTED) {
      device.status = ConnectionStatus.PAIRED;
    }

    logger.info(`Device paired: ${device.deviceInfo.name} (${deviceId})`);
    this.emit("devicePaired", device);

    return { success: true, device };
  }

  /**
   * Unpair a device
   */
  public unpairDevice(deviceId: string): {
    success: boolean;
    device?: RegisteredDevice;
    error?: string;
  } {
    if (!this.devices.has(deviceId)) {
      logger.warn(`Cannot unpair unknown device: ${deviceId}`);
      return { success: false, error: "Device not found" };
    }

    const device = this.devices.get(deviceId)!;

    // Reset pairing status
    device.paired = false;
    device.authToken = undefined;
    device.pairingToken = generateToken();
    device.pairingExpiration = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Update status if paired
    if (device.status === ConnectionStatus.PAIRED) {
      device.status = ConnectionStatus.CONNECTED;
    }

    logger.info(`Device unpaired: ${device.deviceInfo.name} (${deviceId})`);
    this.emit("deviceUnpaired", device);

    return { success: true, device };
  }

  /**
   * Get a device by ID
   */
  public getDeviceById(deviceId: string): RegisteredDevice | null {
    return this.devices.has(deviceId) ? this.devices.get(deviceId)! : null;
  }

  /**
   * Get a device by IP address
   */
  public getDeviceByIp(ip: string): RegisteredDevice | null {
    const deviceId = this.ipToIdMap.get(ip);
    return deviceId ? this.getDeviceById(deviceId) : null;
  }

  /**
   * Get a device by MAC address
   */
  public getDeviceByMac(mac: string): RegisteredDevice | null {
    const deviceId = this.macToIdMap.get(mac);
    return deviceId ? this.getDeviceById(deviceId) : null;
  }

  /**
   * Get a device by connection ID
   */
  public getDeviceByConnectionId(
    connectionId: string,
  ): RegisteredDevice | null {
    for (const device of this.devices.values()) {
      if (device.connectionId === connectionId) {
        return device;
      }
    }
    return null;
  }

  /**
   * Get all registered devices
   */
  public getAllDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get connected devices
   */
  public getConnectedDevices(): RegisteredDevice[] {
    return this.getAllDevices().filter(
      (device) =>
        device.status === ConnectionStatus.CONNECTED ||
        device.status === ConnectionStatus.PAIRED,
    );
  }

  /**
   * Get paired devices
   */
  public getPairedDevices(): RegisteredDevice[] {
    return this.getAllDevices().filter(
      (device) => device.paired && device.status === ConnectionStatus.PAIRED,
    );
  }

  /**
   * Remove a device
   */
  public removeDevice(deviceId: string): boolean {
    if (!this.devices.has(deviceId)) {
      return false;
    }

    const device = this.devices.get(deviceId)!;

    // Remove from maps
    if (device.deviceInfo.ip) {
      this.ipToIdMap.delete(device.deviceInfo.ip);
    }
    if (device.deviceInfo.mac) {
      this.macToIdMap.delete(device.deviceInfo.mac);
    }

    // Remove from devices map
    this.devices.delete(deviceId);

    logger.info(`Device removed: ${device.deviceInfo.name} (${deviceId})`);
    this.emit("deviceRemoved", device);

    return true;
  }

  /**
   * Update device last seen time
   */
  public updateDeviceLastSeen(deviceId: string): boolean {
    if (!this.devices.has(deviceId)) {
      return false;
    }

    const device = this.devices.get(deviceId)!;
    device.lastSeen = Date.now();

    return true;
  }

  /**
   * Clean up old devices that haven't been seen recently
   */
  public cleanupOldDevices(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const cutoffTime = now - maxAge;
    let removedCount = 0;

    for (const [deviceId, device] of this.devices.entries()) {
      if (device.lastSeen < cutoffTime) {
        if (this.removeDevice(deviceId)) {
          removedCount++;
        }
      }
    }

    if (removedCount > 0) {
      logger.info(`Cleaned up ${removedCount} old devices`);
    }

    return removedCount;
  }
}
