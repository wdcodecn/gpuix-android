# Security Policy

Do not report vulnerabilities through a public issue when they involve signing
keys, arbitrary native code execution, unsafe deep links, credential exposure,
or a package-supply-chain issue. Use GitHub's private vulnerability reporting
for this repository.

Never commit Android keystores, `key.properties`, access tokens, private device
logs, local SDK configuration or production application secrets. The included
release configuration uses a debug keystore for local verification only.
