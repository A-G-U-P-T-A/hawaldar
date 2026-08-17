Hawaldar
Authorized reconnaissance workstation

Podman is required. Without a container engine, tools do not run.

After install, open Hawaldar, accept the legal agreement, then use
Set up Podman in the app. That is the install path (winget or the
official MSI, plus a permission prompt). This installer does not
install Podman for you.

Windows: containers need WSL or Hyper-V and CPU virtualization.
macOS: Set up Podman installs Podman and starts the Linux VM.
Linux: Hawaldar locates Podman (or Docker if you already have it).
It will not sudo-install packages.

License: Apache License 2.0 (LICENSE). Authorized-use notice:
LICENSE-USAGE.md. Signing: docs/release/signing.md in the source tree.
