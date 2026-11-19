# Maintain Farstep

Call {{helperTool}} with {{inspectHelper}}, then preview the intended operation.
For example, {{planHelper}} previews an upgrade. Replace `CONNECTION_ID` with
the saved connection ID and choose the operation you intend. Neither call needs
an installed helper. Follow the returned artifact requirements, operation order
and warnings, which depend on the target and package manager.

Use a trusted artifact compatible with the target. Keep the original package
available for recovery. The tool does not install package managers or add
repositories. Coordinate system-wide changes with other users because busy-work
checks cover the connected user, not everyone on the host.

Before upgrading or uninstalling, stop that user's jobs and release desktop
control and workspace leases. After a failure, inspect package and helper state
before resuming with `maintenanceToken`. Package changes are not automatically
undone. Follow the returned recovery instructions.

To cancel an upgrade, restore the original package first. Then use
`action:"upgrade"`, `subcommand:"cancel"` and the returned token. Uninstalling
retains history.

Job readiness includes verification of the selected package's real script
runner, not just the broker. Status reports `scriptRunner.api`,
`scriptRunner.generation` and its canonical `packagePath`. The exact
`cmd-env-effect-v1` API covers the documented `cmd`, `Env` and native Effect
globals. An older helper's coarse TypeScript capability does not establish
compatibility.

If API negotiation fails, upgrade and activate Farstep on the target, then
disconnect and reconnect the target before launching scripts. No user script
runs during negotiation. Existing job inspection uses the saved installation,
scope and native identity independently of new-script compatibility. External
activation changes refresh new-launch routing without replaying operations or
discarding saved job routes.

Reload the agent host after extension updates to load the revised guides and
code.
