# Security policy

## Report a vulnerability

Do not publish exploitable security details in a GitHub issue. Contact the maintainers privately through GitHub or use private vulnerability reporting when available. Include affected versions, a minimal reproduction, impact, and suggested mitigation.

## Scope and limitations

File-access controls apply to bridge file tools. Shell commands are not an OS sandbox and run with the local users privileges. MCP write tools require MCP_ENABLE_WRITES=true, and terminal tools additionally require MCP_ENABLE_TERMINAL=true. Publicly tunneled endpoints require strong authentication and careful token handling.

See docs/SECURITY.md for the complete threat model.
