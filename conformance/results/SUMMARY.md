| framework | version | baseline | sigterm-leader | sigterm | sigkill | mutates in place? |
|---|---|---|---|---|---|---|
| `control-inplace` | n/a | **CLEAN** | **CLEAN** | **CLEAN** | **DIRTY** | yes |
| `cosmic-ray` | 8.4.6 | **SCRATCH** | **DIRTY** | **DIRTY** | **DIRTY** | yes |
| `mutmut` | 3.7.0 | **SCRATCH** | **SCRATCH** | **SCRATCH** | **SCRATCH** | no — sandboxed |
| `pit` | 1.16.1 | **SCRATCH** | **CLEAN** | **CLEAN** | **CLEAN** | no — sandboxed |
| `stryker` | 8.7.1 | **CLEAN** | **SCRATCH** | **SCRATCH** | **SCRATCH** | no — sandboxed |
