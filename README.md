# Arrow Key Control System

A TypeScript-based system for controlling the left and right arrow keys on target devices over a local network. This system allows you to control any device that joins your WiFi network, making it perfect for presentations, shared demos, or remote assistance.

## Features

- **Auto-Discovery**: Target devices are automatically discovered when they join your network
- **Pairing System**: Secure pairing ensures only authorized controllers can send commands
- **Real-Time Control**: Low-latency control of arrow keys on target devices
- **Multi-Device Support**: Control multiple target devices from a single controller
- **Cross-Platform**: Works on Windows, macOS, and Linux

## System Components

This system consists of two main components:

1. **Controller**: Discovers and communicates with target devices on the network
2. **Target**: Receives commands from the controller and simulates arrow key presses

## Prerequisites

- Node.js 14 or higher
- npm or yarn
- For the key simulation to work on targets:
  - Windows: No additional dependencies
  - macOS: May need to grant accessibility permissions
  - Linux: X11 development libraries (`xorg-dev` package on Ubuntu/Debian)

## Installation

1. Clone this repository:

   ```
   git clone https://github.com/yourusername/arrow-control-system.git
   cd arrow-control-system
   ```

2. Install dependencies:

   ```
   npm install
   ```

3. Build the project:
   ```
   npm run build
   ```

## Usage

### Running the Controller

The controller discovers and manages target devices on the network.

```bash
npm run start:controller
```

### Running a Target Device

The target connects to the controller and executes arrow key commands.

```bash
npm run start:target
```

When a target device starts, it will:

1. Broadcast its presence on the network
2. Connect to the controller when discovered
3. Prompt for pairing if necessary
4. Execute arrow key commands when received

### Configuration

Both the controller and target can be configured using environment variables or by creating a `.env` file:

#### Controller Configuration

```
CONTROLLER_ID=custom-controller-id
CONTROLLER_NAME=MyController
WEBSOCKET_PORT=8080
DISCOVERY_PORT=3000
```

#### Target Configuration

```
DEVICE_ID=custom-target-id
DEVICE_NAME=MyTarget
DISCOVERY_PORT=3000
AUTO_ACCEPT_PAIRING=true
```

## Security Considerations

- The pairing system provides basic security by requiring explicit authorization
- Communication is not encrypted by default
- For use in secure environments, consider implementing additional security measures

## Troubleshooting

### Key Simulation Issues

If key simulation is not working:

- Check if the terminal/application has focus on the target device
- Verify the permissions for the key simulation library
- Try switching the key simulation engine by setting `keySimulatorEngine` to 'node-key-sender'

### Connection Issues

If devices cannot connect:

- Ensure both devices are on the same network
- Check if any firewalls are blocking UDP port 3000 or TCP port 8080
- Verify that network discovery/broadcasting is allowed on your network

## License

MIT License - See LICENSE file for details.
