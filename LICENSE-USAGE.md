# Authorized use

This file is **not a license** and **not a clickwrap**. Hawaldar is licensed under the [Apache License 2.0](LICENSE) (patent grant, company-friendly OSS). Companies may use, modify, and distribute the software under that license.

Hawaldar is an authorized reconnaissance / penetration-testing workstation. Use it only when you have a lawful basis, for example:

- systems you own or administer
- written permission from the owner
- a contracted security assessment or pentest engagement

Unauthorized scanning, access, or interference can be a crime. You are responsible for scope, approvals, and local law. An in-app accept records that you saw these terms; it does not replace an engagement letter, statement of work, or counsel.

Tools run only through the in-app container engine (Podman, or Docker if you already have it). The operator remains accountable for every run.

PoC proof probes are gated by explicit in-app approval, one prompt per probe. With that approval they may create benign test records (for example, registering a test user) — point them only at disposable or staging targets that are in scope, never at production data you cannot roll back.
