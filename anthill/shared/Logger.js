// js/config/Logger.js

/**
 * Centralized logger with configurable log levels.
 * All console output should go through this class.
 */
export const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    ERROR: 2,
    NONE: 3
};

class LoggerClass {
    constructor() {
        this._level = LogLevel.INFO;
        this._prefix = '';
    }

    /**
     * Set the current log level.
     * @param {number} level - One of LogLevel.DEBUG, LogLevel.INFO, LogLevel.ERROR, LogLevel.NONE
     */
    setLevel(level) {
        if (level >= LogLevel.DEBUG && level <= LogLevel.NONE) {
            this._level = level;
        }
    }

    /**
     * Get the current log level.
     * @returns {number}
     */
    getLevel() {
        return this._level;
    }

    /**
     * Set an optional prefix for all log messages.
     * @param {string} prefix
     */
    setPrefix(prefix) {
        this._prefix = prefix ? `[${prefix}] ` : '';
    }

    /**
     * Log a debug message. Only shown when level is DEBUG.
     * @param {...any} args
     */
    debug(...args) {
        if (this._level <= LogLevel.DEBUG) {
            console.log(this._prefix, ...args);
        }
    }

    /**
     * Log an info message. Shown when level is DEBUG or INFO.
     * @param {...any} args
     */
    info(...args) {
        if (this._level <= LogLevel.INFO) {
            console.log(this._prefix, ...args);
        }
    }

    /**
     * Log a warning message. Shown when level is DEBUG or INFO.
     * @param {...any} args
     */
    warn(...args) {
        if (this._level <= LogLevel.INFO) {
            console.warn(this._prefix, ...args);
        }
    }

    /**
     * Log an error message. Shown when level is DEBUG, INFO, or ERROR.
     * @param {...any} args
     */
    error(...args) {
        if (this._level <= LogLevel.ERROR) {
            console.error(this._prefix, ...args);
        }
    }

    /**
     * Create a child logger with a specific prefix.
     * Inherits the parent's log level.
     * @param {string} prefix
     * @returns {Object} A logger-like object with the same interface
     */
    createChild(prefix) {
        const parent = this;
        const childPrefix = this._prefix + (prefix ? `[${prefix}] ` : '');
        return {
            debug(...args) {
                if (parent._level <= LogLevel.DEBUG) {
                    console.log(childPrefix, ...args);
                }
            },
            info(...args) {
                if (parent._level <= LogLevel.INFO) {
                    console.log(childPrefix, ...args);
                }
            },
            warn(...args) {
                if (parent._level <= LogLevel.INFO) {
                    console.warn(childPrefix, ...args);
                }
            },
            error(...args) {
                if (parent._level <= LogLevel.ERROR) {
                    console.error(childPrefix, ...args);
                }
            }
        };
    }
}

// Export singleton instance
export const Logger = new LoggerClass();
