/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This is a VSCode extension adapted from the Sublime Text SystemVerilog plugin
 * by Nicolas Belmonte (https://github.com/nicolas3d/SystemVerilog)
 */

const { spawn } = require('child_process');
const path = require('path');
const vscode = require('vscode');

/**
 * Manages the Python daemon process lifecycle and handles JSON-RPC communication
 */
class ProcessManager {
    constructor() {
        this.process = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.isInitialized = false;
        this.initPromise = null;
    }

    /**
     * Get Python executable path
     */
    getPythonPath() {
        const config = vscode.workspace.getConfiguration('svAlign');
        const customPython = config.get('pythonPath');
        if (customPython) {
            return customPython;
        }

        // Try common Python commands
        const { execSync } = require('child_process');
        const pythonCommands = ['python', 'python3', 'py'];
        for (const cmd of pythonCommands) {
            try {
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                return cmd;
            } catch (e) {
                // Continue to next command
            }
        }

        throw new Error('Python not found. Please install Python or configure svAlign.pythonPath');
    }

    /**
     * Start the daemon process
     */
    start() {
        if (this.process && !this.process.killed) {
            return Promise.resolve();
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = new Promise((resolve, reject) => {
            const pythonPath = this.getPythonPath();
            const daemonScript = path.join(__dirname, 'python', 'daemon.py');

            // Spawn Python daemon with UTF-8 encoding
            this.process = spawn(pythonPath, [daemonScript], {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                windowsHide: true
            });

            this.isInitialized = false;
            let initTimeout = null;

            // Set up timeout for initialization
            initTimeout = setTimeout(() => {
                reject(new Error('Daemon initialization timeout'));
                this.stop();
            }, 5000);

            // Handle stdout (JSON-RPC responses)
            this.process.stdout.on('data', (data) => {
                const lines = data.toString().split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const response = JSON.parse(line);

                        // Handle initialization message
                        if (response.method === 'initialized') {
                            this.isInitialized = true;
                            clearTimeout(initTimeout);
                            console.log('Daemon initialized:', response.params);
                            resolve();
                            continue;
                        }

                        // Handle JSON-RPC response
                        if (response.id !== undefined && response.id !== null) {
                            const pending = this.pendingRequests.get(response.id);
                            if (pending) {
                                if (response.error) {
                                    pending.reject(new Error(response.error.message || 'Unknown error'));
                                } else {
                                    pending.resolve(response.result);
                                }
                                this.pendingRequests.delete(response.id);
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse daemon response:', e);
                    }
                }
            });

            // Handle stderr (error messages)
            this.process.stderr.on('data', (data) => {
                console.error('Daemon stderr:', data.toString());
            });

            // Handle process exit
            this.process.on('close', (code) => {
                console.log(`Daemon process exited with code ${code}`);
                this.process = null;
                this.isInitialized = false;
                this.initPromise = null;

                // Reject all pending requests
                for (const [id, pending] of this.pendingRequests) {
                    pending.reject(new Error('Daemon process terminated'));
                }
                this.pendingRequests.clear();
            });

            // Handle spawn error
            this.process.on('error', (error) => {
                clearTimeout(initTimeout);
                console.error('Failed to spawn daemon process:', error);
                reject(error);
            });
        });

        return this.initPromise;
    }

    /**
     * Stop the daemon process
     */
    stop() {
        if (this.process && !this.process.killed) {
            this.process.kill();
            this.process = null;
            this.isInitialized = false;
            this.initPromise = null;
        }

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('Daemon stopped'));
        }
        this.pendingRequests.clear();
    }

    /**
     * Send a JSON-RPC request to the daemon
     */
    async sendRequest(method, params = {}) {
        await this.start();

        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const request = {
                jsonrpc: '2.0',
                id: id,
                method: method,
                params: params
            };

            // Store pending request
            this.pendingRequests.set(id, { resolve, reject });

            // Set timeout for request
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Request timeout'));
            }, 5000);

            // Modify the promise to clear timeout on completion
            const originalResolve = resolve;
            const originalReject = reject;

            const wrappedResolve = (value) => {
                clearTimeout(timeout);
                originalResolve(value);
            };

            const wrappedReject = (error) => {
                clearTimeout(timeout);
                originalReject(error);
            };

            this.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });

            // Send request
            try {
                this.process.stdin.write(JSON.stringify(request) + '\n');
            } catch (error) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(error);
            }
        });
    }

    /**
     * Format text using the daemon
     */
    async format(text, options) {
        const result = await this.sendRequest('format', {
            text: text,
            options: options
        });

        if (result && result.success) {
            return result.result;
        } else {
            throw new Error(result?.error || 'Formatting failed');
        }
    }

    /**
     * Check if daemon is alive
     */
    async ping() {
        const result = await this.sendRequest('ping', {});
        return result && result.status === 'ok';
    }
}

module.exports = ProcessManager;
