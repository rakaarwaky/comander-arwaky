/**
 * Unix Domain Socket Server for DesktopCommanderMCP
 *
 * Provides fast local communication via Unix sockets instead of HTTP.
 * Recommended for production use on Linux/macOS systems.
 *
 * Usage:
 *   node dist/index.js --socket-mode
 *   node dist/index.js --socket-mode --socket-path=/tmp/custom.sock
 *
 * Socket path: /run/desktop-commander/socket (configurable)
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { logger } from './utils/logger.js';

// Default socket configuration
const DEFAULT_SOCKET_PATH = '/run/desktop-commander/socket';
const FALLBACK_SOCKET_PATH = '/tmp/dc.sock'; // Standard socket path for all agents
const SOCKET_READY_TIMEOUT = 5000; // 5 seconds timeout for socket readiness

interface SocketRequest {
    command: string[];
    working_dir?: string;
    timeout?: number;
}

interface SocketResponse {
    stdout: string;
    stderr: string;
    returncode: number;
    executed_by: string;
    error?: string;
}

export class UnixSocketServer {
    private server: net.Server | null = null;
    private socketPath: string;
    private isRunning: boolean = false;

    constructor(socketPath?: string) {
        // Use provided path or default, with fallback for non-root users
        this.socketPath = socketPath || 
            (process.getuid?.() === 0 ? DEFAULT_SOCKET_PATH : FALLBACK_SOCKET_PATH);
    }

    /**
     * Start the Unix socket server
     */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Ensure socket directory exists
                const socketDir = path.dirname(this.socketPath);
                if (!fs.existsSync(socketDir)) {
                    fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
                    logger.info(`Created socket directory: ${socketDir}`);
                }

                // Remove existing socket file if it exists
                if (fs.existsSync(this.socketPath)) {
                    fs.unlinkSync(this.socketPath);
                    logger.info(`Removed existing socket file: ${this.socketPath}`);
                }

                // Create server
                this.server = net.createServer((socket) => {
                    this.handleConnection(socket);
                });

                // Handle server errors
                this.server.on('error', (err) => {
                    logger.error(`Unix socket server error: ${err.message}`);
                    this.isRunning = false;
                    reject(err);
                });

                // Handle server close
                this.server.on('close', () => {
                    logger.info('Unix socket server closed');
                    this.isRunning = false;
                });

                // Start listening
                this.server.listen(this.socketPath, () => {
                    this.isRunning = true;
                    // Set socket permissions to allow all users (for systemd socket activation compatibility)
                    try {
                        fs.chmodSync(this.socketPath, 0o666);
                    } catch (chmodErr) {
                        logger.warning(`Could not set socket permissions: ${chmodErr instanceof Error ? chmodErr.message : String(chmodErr)}`);
                    }
                    logger.info(`Unix socket server listening on ${this.socketPath}`);
                    resolve();
                });

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to start Unix socket server: ${errorMsg}`);
                reject(error);
            }
        });
    }

    /**
     * Stop the Unix socket server
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    logger.info('Unix socket server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Handle incoming socket connection
     */
    private handleConnection(socket: net.Socket): void {
        let dataBuffer = '';
        let processing = false;

        socket.on('data', async (chunk: Buffer) => {
            dataBuffer += chunk.toString();

            // Prevent re-entrancy while processing
            if (processing) {
                return;
            }

            // Try to parse complete lines as JSON
            const lines = dataBuffer.split('\n');
            // Keep incomplete line in buffer
            dataBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;

                // Try to parse as JSON (complete message)
                try {
                    processing = true;
                    const request: SocketRequest = JSON.parse(line);
                    
                    const response = await this.executeCommand(request);
                    socket.write(JSON.stringify(response) + '\n');
                    processing = false;
                } catch (parseError) {
                    processing = false;
                    
                    // Malformed JSON - log and skip this line
                    logger.warning(`Invalid JSON from client: ${line.substring(0, 100)}...`);
                    
                    // Check if accumulated data is too large
                    if (dataBuffer.length > 1024 * 1024) { // 1MB limit
                        logger.error(`Client exceeded max request size: ${dataBuffer.length} bytes`);
                        const errorResponse: SocketResponse = {
                            stdout: '',
                            stderr: 'Request too large (max 1MB)',
                            returncode: 1,
                            executed_by: 'DesktopCommanderMCP',
                            error: 'Request size exceeded limit'
                        };
                        socket.end(JSON.stringify(errorResponse) + '\n');
                        return;
                    }
                }
            }
        });

        socket.on('error', (err) => {
            // Ignore ECONNRESET - normal when client disconnects abruptly
            if (err.message.includes('ECONNRESET')) {
                logger.debug('Client connection reset');
            } else {
                logger.error(`Socket error: ${err.message}`);
            }
        });

        socket.on('end', () => {
            logger.debug('Client disconnected');
        });

        socket.on('close', () => {
            logger.debug('Socket closed');
        });

        socket.on('timeout', () => {
            logger.warning('Socket timeout - closing connection');
            socket.end();
        });

        // Set socket timeout (5 minutes max)
        socket.setTimeout(300000);
    }

    /**
     * Execute command and return result
     */
    private async executeCommand(request: SocketRequest): Promise<SocketResponse> {
        const { command, working_dir = '.', timeout = 300 } = request;

        logger.info(`Executing command via Unix socket: ${command.join(' ')}`);

        return new Promise((resolve) => {
            const [cmd, ...args] = command;
            let stdout = '';
            let stderr = '';

            try {
                const proc = spawn(cmd, args, {
                    cwd: working_dir,
                    shell: false,
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                // Set timeout
                const timeoutId = setTimeout(() => {
                    proc.kill('SIGKILL');
                    stderr += `\nCommand timed out after ${timeout} seconds\n`;
                }, timeout * 1000);

                proc.stdout?.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });

                proc.stderr?.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                proc.on('error', (err) => {
                    clearTimeout(timeoutId);
                    resolve({
                        stdout: '',
                        stderr: `Failed to start process: ${err.message}`,
                        returncode: 1,
                        executed_by: 'DesktopCommanderMCP',
                        error: err.message
                    });
                });

                proc.on('close', (code) => {
                    clearTimeout(timeoutId);
                    resolve({
                        stdout,
                        stderr,
                        returncode: code ?? 1,
                        executed_by: 'DesktopCommanderMCP'
                    });
                });

            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                resolve({
                    stdout: '',
                    stderr: `Failed to execute: ${errorMsg}`,
                    returncode: 1,
                    executed_by: 'DesktopCommanderMCP',
                    error: errorMsg
                });
            }
        });
    }

    /**
     * Check if server is running
     */
    getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get socket path
     */
    getSocketPath(): string {
        return this.socketPath;
    }

    /**
     * Wait until socket file exists and is ready for connections
     * This prevents ECONNREFUSED race conditions
     */
    async waitForReady(timeout: number = SOCKET_READY_TIMEOUT): Promise<void> {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            // Check if socket file exists
            if (fs.existsSync(this.socketPath)) {
                // Additional check: try to connect to verify it's actually listening
                try {
                    await new Promise<void>((resolve, reject) => {
                        const testSocket = net.createConnection({ path: this.socketPath });
                        const testTimeout = setTimeout(() => {
                            testSocket.destroy();
                            reject(new Error('Socket connection timeout'));
                        }, 1000);
                        
                        testSocket.on('connect', () => {
                            clearTimeout(testTimeout);
                            testSocket.destroy();
                            resolve();
                        });
                        
                        testSocket.on('error', (err) => {
                            clearTimeout(testTimeout);
                            // Socket exists but not ready yet, continue waiting
                            if (err.message.includes('ECONNREFUSED')) {
                                resolve(); // Will retry in next iteration
                            } else {
                                reject(err);
                            }
                        });
                    });
                    return; // Socket is ready
                } catch {
                    // Socket exists but not ready, continue waiting
                }
            }
            
            // Wait 50ms before next check
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        throw new Error(
            `Socket not ready after ${timeout}ms. Path: ${this.socketPath}. ` +
            `Server may have failed to start or socket path may be incorrect.`
        );
    }
}

// Singleton instance
let unixSocketServerInstance: UnixSocketServer | null = null;

export function getUnixSocketServer(socketPath?: string): UnixSocketServer {
    if (!unixSocketServerInstance) {
        unixSocketServerInstance = new UnixSocketServer(socketPath);
    }
    return unixSocketServerInstance;
}

/**
 * Start Unix socket server if --socket-mode flag is provided
 */
export async function startUnixSocketServerIfNeeded(argv: string[]): Promise<UnixSocketServer | null> {
    if (argv.includes('--socket-mode')) {
        const socketPathArg = argv.find(arg => arg.startsWith('--socket-path='));
        const socketPath = socketPathArg ? socketPathArg.split('=')[1] : undefined;

        const server = getUnixSocketServer(socketPath);
        await server.start();
        
        // Wait for socket to be ready before returning
        try {
            await server.waitForReady();
            logger.info(`Unix socket server ready and accepting connections on ${server.getSocketPath()}`);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Unix socket server failed to become ready: ${errorMsg}`);
            throw err;
        }
        
        return server;
    }
    return null;
}

/**
 * Utility function for clients to test socket connectivity
 * Returns true if socket is ready and accepting connections
 */
export async function testSocketConnection(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const testSocket = net.createConnection({ path: socketPath });
        const timeout = setTimeout(() => {
            testSocket.destroy();
            resolve(false);
        }, 2000);
        
        testSocket.on('connect', () => {
            clearTimeout(timeout);
            testSocket.destroy();
            resolve(true);
        });
        
        testSocket.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}