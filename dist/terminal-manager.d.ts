import { TerminalSession, CommandExecutionResult, ActiveSession } from './types.js';
interface CompletedSession {
    pid: number;
    outputLines: string[];
    exitCode: number | null;
    startTime: Date;
    endTime: Date;
}
export interface PaginatedOutputResult {
    lines: string[];
    totalLines: number;
    readFrom: number;
    readCount: number;
    remaining: number;
    isComplete: boolean;
    exitCode?: number | null;
    runtimeMs?: number;
}
export declare class TerminalManager {
    private sessions;
    private completedSessions;
    /**
     * Send input to a running process
     * @param pid Process ID
     * @param input Text to send to the process
     * @returns Whether input was successfully sent
     */
    sendInputToProcess(pid: number, input: string): boolean;
    executeCommand(command: string, timeoutMs?: number, shell?: string, collectTiming?: boolean): Promise<CommandExecutionResult>;
    /**
     * Append text to a session's line buffer
     * Handles partial lines and newline splitting
     */
    private appendToLineBuffer;
    /**
     * Read process output with pagination (like file reading)
     * @param pid Process ID
     * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
     * @param length Max lines to return
     * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
     */
    readOutputPaginated(pid: number, offset?: number, length?: number): PaginatedOutputResult | null;
    /**
     * Internal helper to read from a line buffer with offset/length
     */
    private readFromLineBuffer;
    /**
     * Get total line count for a process
     */
    getOutputLineCount(pid: number): number | null;
    /**
     * Legacy method for backward compatibility
     * Returns all new output since last read
     * @param maxLines Maximum lines to return (default: 1000 for context protection)
     * @deprecated Use readOutputPaginated instead
     */
    getNewOutput(pid: number, maxLines?: number): string | null;
    /**
     * Capture a snapshot of current output state for interaction tracking.
     * Used by interactWithProcess to know what output existed before sending input.
     */
    captureOutputSnapshot(pid: number): {
        totalChars: number;
        lineCount: number;
    } | null;
    /**
     * Get output that appeared since a snapshot was taken.
     * This handles the case where output is appended to the last line (REPL prompts).
     * Also checks completed sessions in case process finished between snapshot and poll.
     */
    getOutputSinceSnapshot(pid: number, snapshot: {
        totalChars: number;
        lineCount: number;
    }): string | null;
    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
    getSession(pid: number): TerminalSession | undefined;
    forceTerminate(pid: number): boolean;
    listActiveSessions(): ActiveSession[];
    listCompletedSessions(): CompletedSession[];
}
export declare const terminalManager: TerminalManager;
export {};
