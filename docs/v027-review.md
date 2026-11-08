# 0.2.7 review corrections

Reviewed against release `d3718369fb74cfded92b8b533a65807d4589351a`. All reproductions use synthetic credentials/streams and temporary files, not the running profile or paid requests.

## Confirmed issues and fixes

1. **P2 — quadratic SVG extraction on the main thread.** Repeated unfinished `<svg ` prefixes within the 256 KiB reply budget caused quadratic regex backtracking before the worker. Extraction now uses bounded linear searches. An absolute attempt deadline is checked even if timers have not run. Tests cover wrapped/nested/self-closing SVG, pathological unfinished prefixes and clock advances without timer delivery. The worker remains the XML/security authority.
2. **P2 — export cancellation bypassed the reader bound.** Logical stream termination released the reader slot while an asynchronous generator still retained its scan buffers and blocked read. A local abort signal now stops the scanner, and its quota is held until the iterator actually exits. Tests hold file reads behind deterministic gates and exercise abort, body cancel, clear, disposal, corruption, setup waits and IO failure. An OS read cannot be forcibly interrupted; its slot deliberately stays reserved until it settles.
3. **P2 — temporary credential failure permanently poisoned the remote catalog.** An invalidated binding signal stayed in the stable route catalog after the same account recovered. New calls now discard the invalidated remote snapshot and use the native catalog until a fresh synchronization succeeds. Old prepared calls remain invalid. Unit and real account-registry/router tests verify recovery without reload and zero model IO from old calls.
4. **P2 — activation used pre-ACK model options.** A target account could gain models while activation was pending, but the UI kept its stale unsupported result and chooser. The client now revalidates against the acknowledged account model list and current directory metadata, while checking both the original session and model selection before and after asynchronous work. Newly supported models are selectable even if the shared directory update is late; withdrawn options are omitted.

## Validation

- Node 24.21.0: full suite **838 passed, 0 failed, 0 skipped**.
- Node 22.20.0: full suite **838 passed, 0 failed, 0 skipped**.
- Clean packed consumer installation: imports and real 1024×1024 WASM PNG rendering passed on both Node versions, with runtime network disabled. The three shipped client files matched their released archive SHA-256 values exactly.
- Backend entry compatibility now covers every retired path from v022 through v026, forwarding directly to v027.
- Shipped v024/v025/v026 client assets remain unchanged; corrected code ships at a new v027 asset path.
- No live model/OAuth request, profile/credential-file read, plugin installation or GUI reload was performed. Synthetic UI tests are not pixel-level acceptance of the running GUI.
