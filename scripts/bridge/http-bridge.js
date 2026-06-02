#!/usr/bin/env node
/**
 * DesktopCommander HTTP Bridge
 * 
 * Provides HTTP endpoint to execute commands via DesktopCommander MCP.
 * Run this script separately, then agentic-testing can call it.
 * 
 * Usage:
 *   node http-bridge.js
 * 
 * Then set:
 *   export DESKTOP_COMMANDER_URL="http://localhost:8080/execute"
 *   export USE_DESKTOP_COMMANDER_MCP=true
 */

import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 8080;
const SOCKET_PATH = '/run/desktop-commander/socket';

// Simulated DesktopCommander tools
const AVAILABLE_TOOLS = {
    'start_process': {
        description: 'Execute terminal commands',
        params: { command: 'string', timeout_ms: 'number' }
    },
    'read_file': {
        description: 'Read files from filesystem',
        params: { path: 'string', offset: 'number', length: 'number' }
    },
    'write_file': {
        description: 'Write files to filesystem',
        params: { path: 'string', content: 'string' }
    }
};

const server = http.createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.url === '/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const request = JSON.parse(body);
                const { command, working_dir, timeout } = request;
                
                console.log(`[HTTP Bridge] Executing: ${command.join(' ')}`);
                
                // Execute command via child_process (simulating DesktopCommander)
                const result = await new Promise((resolve) => {
                    const proc = spawn(command[0], command.slice(1), {
                        cwd: working_dir || process.cwd(),
                        shell: true
                    });
                    
                    let stdout = '';
                    let stderr = '';
                    
                    proc.stdout.on('data', data => stdout += data.toString());
                    proc.stderr.on('data', data => stderr += data.toString());
                    
                    proc.on('close', (code) => {
                        resolve({
                            stdout,
                            stderr,
                            returncode: code || 0,
                            executed_by: 'desktop-commander-http-bridge'
                        });
                    });
                    
                    proc.on('error', (err) => {
                        resolve({
                            stdout: '',
                            stderr: err.message,
                            returncode: 1,
                            executed_by: 'desktop-commander-http-bridge'
                        });
                    });
                    
                    setTimeout(() => {
                        proc.kill();
                        resolve({
                            stdout,
                            stderr: 'Command timed out',
                            returncode: 124,
                            executed_by: 'desktop-commander-http-bridge'
                        });
                    }, timeout || 30000);
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    } else if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            tools: Object.keys(AVAILABLE_TOOLS),
            mode: 'http-bridge'
        }));
    } else if (req.url === '/tools' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(AVAILABLE_TOOLS));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         DesktopCommander HTTP Bridge                          ║
╠═══════════════════════════════════════════════════════════════╣
║  HTTP Endpoint: http://localhost:${PORT}/execute                ║
║  Health Check:   http://localhost:${PORT}/health                 ║
║  Tools List:     http://localhost:${PORT}/tools                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Ready to accept commands from agentic-testing!                ║
╚═══════════════════════════════════════════════════════════════╝
`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        console.error('Another instance may be running, or use a different port.');
        process.exit(1);
    }
    throw err;
});