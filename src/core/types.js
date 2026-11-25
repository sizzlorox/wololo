// Shared type definitions. Every command, adapter and rule speaks these shapes.

/**
 * @typedef {'string' | 'boolean' | 'number' | 'string[]'} OptionType
 *
 * @typedef {object} OptionSpec
 * @property {OptionType} type
 * @property {string} description
 * @property {unknown} [default]
 *
 * @typedef {object} PositionalSpec
 * @property {string} name
 * @property {string} description
 * @property {boolean} [required]
 * @property {boolean} [variadic]
 */

/**
 * @typedef {Record<string, any>} Input
 *
 * @typedef {object} Result
 * @property {boolean} ok
 * @property {string} summary
 * @property {string[]} [details]
 * @property {any} [data]
 * @property {number} [exitCode]   Overrides the default exit code (0 when ok, 1 otherwise).
 * @property {string} [stdout]     Raw text to print instead of the summary (used by hooks).
 * @property {string} [stderr]
 *
 * @typedef {object} Ctx
 * @property {string} cwd
 * @property {string} root
 * @property {import('./config.js').Config} config
 * @property {boolean} hasConfig
 * @property {() => Promise<string>} readStdin
 * @property {NodeJS.ProcessEnv} env
 * @property {(question: string, fallback?: string) => Promise<string>} [prompt]  Only set in an interactive terminal.
 * @property {(line: string) => void} [say]  Interactive-only progress text (never stdout).
 *
 * @typedef {object} Command
 * @property {string} name              Space separated, e.g. "queue add". MCP tool name replaces spaces with "_".
 * @property {string} summary
 * @property {Record<string, OptionSpec>} [options]
 * @property {PositionalSpec[]} [args]
 * @property {boolean} [mcp]            Expose as MCP tool (default true).
 * @property {(input: Input, ctx: Ctx) => Promise<Result>} run
 */

export {};
