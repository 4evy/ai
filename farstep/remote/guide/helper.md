# Maintain Farstep

Call {{helperTool}} with {{inspectHelper}}, then preview the intended operation.
For example, {{planHelper}} previews an upgrade. Use the saved connection ID and
the operation you intend. Neither call needs an installed helper. Follow the
returned artifact requirements, operation order and warnings; they depend on the
target and package manager.

Use a trusted artifact compatible with the target. Keep the original package
available for recovery. The tool does not install package managers or add
repositories. Coordinate system-wide changes with other users: busy-work checks
cover the connected user, not everyone on the host.

Before upgrade or uninstall, stop that user's jobs and release desktop control
and workspace leases. After failure, inspect package and helper state before
resuming with maintenanceToken; package changes are not automatically undone.
Follow the returned recovery instructions. To cancel an upgrade, restore the
original package first, then use action:"upgrade", subcommand:"cancel" and the
returned token. Uninstall retains history.

Reload the agent host after extension updates to load the revised guides and
code.
