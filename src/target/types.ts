import { type DeviceInfo, ConnectionStatus } from "../shared/types";

/**
 * Target device config
 */
export interface TargetDeviceConfig {
  // Device identification
  deviceId?: string;
  deviceName?: string;

  // Connection settings
  discoveryPort?: number;
  autoConnect?: boolean;
  autoAcceptPairing?: boolean;

  // Key simulator settings
  keySimulatorEngine?: "robotjs" | "node-key-sender";
  keySimulatorVerbose?: boolean;

  // Advanced settings
  heartbeatInterval?: number;
  reconnectMaxAttempts?: number;
  reconnectInitialDelay?: number;
}

/**
 * Target device status information
 */
export interface TargetDeviceStatus {
  deviceInfo: DeviceInfo;
  connectionStatus: ConnectionStatus;
  controllerInfo: {
    id?: string;
    name?: string;
    ip?: string;
    port?: number;
  } | null;
  paired: boolean;
  lastCommandTime?: number;
  lastCommandType?: string;
  uptime: number;
}
