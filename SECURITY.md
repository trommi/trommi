# Security

Security measures:

- Branch protection
- Signed commits only
- Secret scanning with push protection
- Protected release tags
- Nothing of Trommi runs as root on the hub's server: the hub runs as `trommi`, the updater as `trommi-updater`; root runs only `hub/deploy/hub-ctl.sh`, which takes `start` or `stop` for the hub's unit and nothing else (README, "How the hub is deployed")
