#!/bin/bash
# DesktopCommanderMCP Systemd Service Installation Script
# 
# This script installs and configures systemd services for DesktopCommanderMCP
# Supports both Unix Socket (recommended) and HTTP modes
#
# Usage:
#   sudo ./install-systemd-services.sh [--http] [--uninstall]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DC_DIR="$(dirname "$SCRIPT_DIR")"
SYSTEMD_DIR="/etc/systemd/system"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default mode
MODE="unix"
UNINSTALL=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --http)
            MODE="http"
            shift
            ;;
        --uninstall)
            UNINSTALL=true
            shift
            ;;
        --help)
            echo "DesktopCommanderMCP Systemd Service Installer"
            echo ""
            echo "Usage: sudo $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --http       Install HTTP mode service (default: Unix Socket)"
            echo "  --uninstall  Remove installed services"
            echo "  --help       Show this help message"
            echo ""
            echo "Recommended: Unix Socket mode (faster, more secure)"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}This script must be run as root (use sudo)${NC}"
    exit 1
fi

# Check if DesktopCommander is built
if [[ ! -f "$DC_DIR/dist/index.js" ]]; then
    echo -e "${YELLOW}DesktopCommander not built yet. Building...${NC}"
    cd "$DC_DIR"
    npm install
    npm run build
fi

# Create socket directory
if [[ "$MODE" == "unix" ]]; then
    echo -e "${GREEN}Creating Unix socket directory...${NC}"
    mkdir -p /run/desktop-commander
    chown root:root /run/desktop-commander
    chmod 755 /run/desktop-commander
fi

if [[ "$UNINSTALL" == true ]]; then
    echo -e "${YELLOW}Uninstalling DesktopCommanderMCP services...${NC}"
    
    # Stop services
    systemctl stop desktop-commander.service 2>/dev/null || true
    systemctl stop desktop-commander.socket 2>/dev/null || true
    systemctl stop desktop-commander-http.service 2>/dev/null || true
    
    # Disable services
    systemctl disable desktop-commander.service 2>/dev/null || true
    systemctl disable desktop-commander.socket 2>/dev/null || true
    systemctl disable desktop-commander-http.service 2>/dev/null || true
    
    # Remove service files
    rm -f "$SYSTEMD_DIR/desktop-commander.service"
    rm -f "$SYSTEMD_DIR/desktop-commander.socket"
    rm -f "$SYSTEMD_DIR/desktop-commander-http.service"
    
    # Reload systemd
    systemctl daemon-reload
    
    # Remove socket directory
    rm -rf /run/desktop-commander
    
    echo -e "${GREEN}DesktopCommanderMCP services uninstalled successfully${NC}"
    exit 0
fi

# Install services
echo -e "${GREEN}Installing DesktopCommanderMCP services (Mode: $MODE)...${NC}"

if [[ "$MODE" == "unix" ]]; then
    # Install Unix Socket mode
    echo "  - Installing desktop-commander.socket"
    cp "$SCRIPT_DIR/desktop-commander.socket" "$SYSTEMD_DIR/"
    
    echo "  - Installing desktop-commander.service"
    # Update ExecStart path in service file
    sed "s|/persistent/home/raka/mcp-servers|$DC_DIR|g" \
        "$SCRIPT_DIR/desktop-commander.service" > "$SYSTEMD_DIR/desktop-commander.service"
    
    # Enable and start socket
    systemctl daemon-reload
    systemctl enable desktop-commander.socket
    systemctl start desktop-commander.socket
    
    # Wait for socket to be ready
    sleep 2
    
    # Check if socket exists
    if [[ -S /run/desktop-commander/socket ]]; then
        echo -e "${GREEN}✓ Unix socket created at /run/desktop-commander/socket${NC}"
    else
        echo -e "${RED}✗ Socket not found. Checking status...${NC}"
        systemctl status desktop-commander.socket || true
        exit 1
    fi
    
    # Start the service handler
    systemctl enable desktop-commander.service
    systemctl start desktop-commander.service
    
    echo -e "${GREEN}✓ DesktopCommanderMCP Unix Socket service installed${NC}"
    
else
    # Install HTTP mode
    echo "  - Installing desktop-commander-http.service"
    # Update ExecStart path in service file
    sed "s|/persistent/home/raka/mcp-servers|$DC_DIR|g" \
        "$SCRIPT_DIR/desktop-commander-http.service" > "$SYSTEMD_DIR/desktop-commander-http.service"
    
    # Enable and start
    systemctl daemon-reload
    systemctl enable desktop-commander-http.service
    systemctl start desktop-commander-http.service
    
    # Wait for service to be ready
    sleep 3
    
    # Check if service is running
    if systemctl is-active --quiet desktop-commander-http.service; then
        echo -e "${GREEN}✓ DesktopCommanderMCP HTTP service running on port 8080${NC}"
    else
        echo -e "${RED}✗ Service failed to start. Checking status...${NC}"
        systemctl status desktop-commander-http.service || true
        exit 1
    fi
    
    echo -e "${GREEN}✓ DesktopCommanderMCP HTTP service installed${NC}"
fi

# Show status
echo ""
echo -e "${GREEN}=== Installation Complete ===${NC}"
echo ""

if [[ "$MODE" == "unix" ]]; then
    echo "Service Status:"
    systemctl status desktop-commander.socket --no-pager -l || true
    echo ""
    systemctl status desktop-commander.service --no-pager -l || true
    echo ""
    echo "Socket Location: /run/desktop-commander/socket"
    echo ""
    echo "To set environment variable for MCP servers:"
    echo '  export DESKTOP_COMMANDER_URL="/run/desktop-commander/socket"'
else
    echo "Service Status:"
    systemctl status desktop-commander-http.service --no-pager -l || true
    echo ""
    echo "HTTP Endpoint: http://localhost:8080/execute"
    echo ""
    echo "To set environment variable for MCP servers:"
    echo '  export DESKTOP_COMMANDER_URL="http://localhost:8080/execute"'
fi

echo ""
echo -e "${GREEN}Done!${NC}"
