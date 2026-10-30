# Publicar Umbra en npm desde Codex y WSL

Este procedimiento registra lo que funcionó al publicar `@dastbal/umbra@2.4.2`
el 2026-10-29. David completa la autenticación y el MFA en el navegador. El agente
ejecuta y verifica los comandos, sin guardar tokens, códigos ni enlaces temporales.

## 1. Confirmar el candidato

Trabajar desde el worktree que contiene la versión aprobada. La rama debe estar
limpia y su commit debe estar integrado en `origin/main`:

```bash
cd /home/david/projects/ai-local/umbra/.claude/worktrees/worktree-overlay
export PATH=/home/david/.nvm/versions/node/v24.22.0/bin:$PATH
export NPM_CONFIG_CACHE=/tmp/umbra-npm-cache
git fetch origin main
git status --short
git merge-base --is-ancestor HEAD origin/main
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
```

`git status --short` debe estar vacío, la comprobación de ancestro debe salir con
código 0 y ambas versiones deben coincidir. Confirmar también que el PR está
fusionado y que los checks de CI pasaron. No reutilizar ciegamente el número de
PR ni la versión de la publicación anterior.

## 2. Verificar y preparar exactamente lo que se enviará

```bash
npm run type-check
npm test -- --testPathIgnorePatterns='/node_modules/|/dist/' --silent
npm run build
npm pack --pack-destination /tmp
```

La opción de Jest es necesaria en este worktree porque `.claude/` queda excluido
por defecto. Revisar que el paquete contenga `dist/index.js`,
`dist/index.d.ts`, `dist/bin/launcher.js`, `dist/bin/cli.js`, `README.md` y
`package.json`, sin `.env`, bases de datos, claves ni `node_modules`. Registrar
el SHA-1 del tarball: npm lo publica como `dist.shasum`.

Antes de publicar, consultar la versión exacta en el registro con una caché
nueva. Si ya existe, detenerse: npm no permite reutilizar una versión.

```bash
npm whoami
NPM_CONFIG_CACHE=/tmp/umbra-npm-prepublish-check npm view @dastbal/umbra@VERSION version --prefer-online
```

Sustituir `VERSION` por la versión del paquete. `E404` significa que esa versión
todavía no aparece en el registro; comprobarlo justo antes de publicar.

## 3. Publicar con MFA

En esta sesión de Codex sobre WSL, `BROWSER=/mnt/c/Windows/explorer.exe` no abrió
el navegador: `sensible-browser` salió con código 1 y `npm publish` se detuvo.
El flujo que sí funcionó fue mantener la CLI esperando, copiar el enlace nuevo
que imprimió npm y abrirlo manualmente en Windows:

```bash
BROWSER=/bin/true npm publish /tmp/dastbal-umbra-VERSION.tgz --access public
```

Cuando la CLI diga `Authenticate your account at:`, pasar **ese enlace del intento
actual** a David. Pulsar Enter en la terminal; `/bin/true` evita el fallo del
lanzador y la CLI espera la autorización. David abre el enlace y completa el MFA.
Esperar la línea `+ @dastbal/umbra@VERSION` y el código de salida 0. Si `npm
whoami` devuelve `E401`, iniciar sesión primero con
`BROWSER=/bin/true npm login --auth-type=web` y el mismo intercambio de enlace.
No poner códigos MFA ni tokens en comandos, archivos o registros.

## 4. Comprobar el registro, sin repetir la publicación

```bash
NPM_CONFIG_CACHE=/tmp/umbra-npm-fresh-version npm view @dastbal/umbra@VERSION version dist.shasum --json --prefer-online
NPM_CONFIG_CACHE=/tmp/umbra-npm-fresh-tags npm dist-tag ls @dastbal/umbra --prefer-online
```

Exigir que la versión exacta exista, que `dist.shasum` coincida con el tarball
enviado y que `latest` apunte a ella. Tras la aceptación de 2.4.2, la caché
anterior seguía devolviendo `E404` y `latest: 2.4.1`; con una caché nueva y el
endpoint público del registro se confirmó 2.4.2. **No ejecutar `npm publish`
otra vez solo por ese retraso.** Si persiste la duda, consultar directamente:

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://registry.npmjs.org/@dastbal%2Fumbra/VERSION'
curl -fsS -H 'Cache-Control: no-cache' 'https://registry.npmjs.org/-/package/@dastbal%2Fumbra/dist-tags'
```

## Evidencia de la publicación 2.4.2

- PR [#33](https://github.com/dastbal/umbra/pull/33) fusionado en `main` como `5157a2c8cba7e1ab440d0b19e3543a938376b34d`.
- Tarball `dastbal-umbra-2.4.2.tgz`: 415 archivos; SHA-1 `306a7d439b8d35ccb3a0cc0daac798806060f0f2`.
- `npm publish` terminó con `+ @dastbal/umbra@2.4.2` y código 0 tras la autorización de David.
- El registro público devolvió versión `2.4.2`, el mismo `dist.shasum` y `latest: 2.4.2`.

Referencias: [npm login con navegador](https://docs.npmjs.com/accessing-npm-using-2fa/) y
[npm publish y MFA](https://docs.npmjs.com/cli/commands/npm-publish/).
