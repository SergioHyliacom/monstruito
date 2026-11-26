<p align="center">
  <img src="assets/logo.png" width="180" alt="Monstruito, un gato negro mirando hacia arriba">
</p>

<h1 align="center">Monstruito</h1>

Plugin de [Orca](https://github.com/stablyai/orca) que deja tus proyectos listos al abrir Orca. En cada proyecto que marques, y en este orden:

1. **Git**: trae los cambios de la rama actual, o solo los descarga, o no toca nada.
2. **Dependencias**: si el avance cambió un lockfile, o si faltan (un clon nuevo), las instala y espera a que acabe.
3. **Comandos de preparación**: los del proyecto que van en segundo plano (`docker compose up -d`, migraciones…), esperando a cada uno.
4. **Worktrees**: si lo pides, dice cuántos commits va por detrás cada uno de los demás worktrees.
5. **Agente**: abre Claude (u otro agente) de la forma que elijas.
6. **Comandos en pestaña**: los del proyecto que se quedan corriendo (`npm run dev`…), cada uno en la suya, y si quieres abre su web en el navegador de Orca.

Al terminar puede mostrarte un proyecto para empezar a trabajar ahí.

## Instalar

```sh
orca plugin install SergioHyliacom/monstruito
```

Monstruito ejecuta código en tu equipo (git, instalaciones, comandos), así que Orca pide aprobar sus permisos: la orden anterior responde con el comando exacto, con `--approve`, para hacerlo. Después, el panel **Monstruito** aparece en la barra lateral (icono de cohete).

Necesita Orca 1.4.259 o posterior.

## Uso

En el panel **Monstruito** (icono de cohete):

- **Perfil:** elige con qué conjunto de proyectos trabajas (por ejemplo Trabajo o Casa), o crea uno con **+**.
- **Elegir proyectos:** marca las casillas del árbol. Va por carpetas, de más reciente a más antiguo según tu actividad en Orca; las carpetas se pliegan y se recuerda cuáles tienes abiertas. **Marcar los N** marca una carpeta entera. Lo marcado pasa a una lista aparte, arriba.
- **Ejecutar ahora:** hace lo mismo que al abrir Orca, con el perfil elegido. Mientras va, el panel enseña qué proyecto está en qué paso.
- **Revisar commits:** descarga y cuenta lo que hay por traer, sin mover nada ni abrir agentes.
- **Detener:** corta lo que esté en marcha. Lo hecho se queda; lo que falta no se empieza.
- **Historial:** la última ejecución y, plegadas, las 9 anteriores.
- **Recargar proyectos** (↻): vuelve a pedir los proyectos a Orca y quita la búsqueda. El panel también se actualiza solo cuando Orca avisa de que se ha creado o quitado un workspace.
- **Ajustes** (⚙): los de todos los perfiles o los del perfil elegido, y exportar o importar.
- **Ajustes y comandos de un proyecto:** el engranaje junto a él.
- **Cerrar pestañas (N):** cierra de una vez las pestañas de comandos que abrió Monstruito.

## Comandos

Cada proyecto tiene su lista de comandos, en su engranaje, pestaña **Comandos**. Valen en todos los perfiles; un perfil puede apagarlos todos con «Ejecutar los comandos de cada proyecto».

- **Tipo:** *en su pestaña* (servidores, watchers: se abren al final y no se esperan) o *preparación* (en segundo plano antes de abrir el agente, esperando a que acabe; si falla, se cuenta y se sigue).
- **Cuándo:** siempre, solo si entran commits, o solo si cambian ciertos archivos. Los archivos van desde la raíz del proyecto, separados por comas: `carpeta/` es todo lo de dentro, y valen `*` (dentro de una carpeta) y `**` (a cualquier profundidad). Por ejemplo `database/migrations/` para `php artisan migrate`.
- **Reiniciar si ya está abierto:** cierra su pestaña y la abre otra vez. Solo puede con las pestañas que abrió Monstruito.
- **Abrir la web cuando esté lista:** antes de abrir la pestaña mira qué puertos tiene el workspace; después espera (hasta 2 minutos) a uno nuevo y abre su dirección en el navegador de Orca, por detrás, sin moverte de donde estás.
- **Sugerencias:** al abrir el engranaje propone comandos según el proyecto: scripts de `package.json` (con npm, pnpm, yarn o bun según el lockfile) y de `composer.json`, Laravel (`artisan`), docker compose, Makefile, Flutter, Django, Cargo y Go. Un clic los añade.

Una pestaña de comando se llama «Monstruito: nombre» (o el comando, si no tiene nombre); así se reconoce si ya está abierta.

La barra de estado muestra el resumen de la última ejecución o revisión. Pulsarla ejecuta el arranque.

Por defecto no hay ningún proyecto marcado, así que instalarlo no hace nada hasta que elijas.

## Perfiles

Cada perfil tiene sus proyectos marcados y, además:

- **Días:** al abrir Orca esos días se usa ese perfil (por ejemplo Trabajo de lunes a viernes y Casa los fines de semana). Un día solo puede ser de un perfil; los días sin perfil se usa el elegido en el panel.
- **Al terminar, mostrar:** nada, el marcado usado más recientemente o uno concreto. Solo al abrir Orca, para no moverte de sitio cuando ejecutas a mano.
- **Ajustes propios:** cualquier ajuste general puede ser distinto en ese perfil.

Los ajustes se aplican en tres capas: **todos los perfiles** (los de Settings) → **el perfil** → **el proyecto**. Los ajustes de un proyecto valen en todos los perfiles, porque describen al proyecto (su comando de arranque, por ejemplo).

Lo marcado con versiones anteriores pasa a un perfil «Principal».

## Exportar e importar

En **Ajustes → Exportar o importar**:

- **Exportar** guarda en un archivo los perfiles, los ajustes de todos los perfiles y los de cada proyecto.
- **Importar:** pega el contenido del archivo (los paneles de Orca no pueden abrir archivos). Los proyectos se buscan por ruta y, si no está, por nombre, para que sirva en otro equipo; si dos se llaman igual, no se adivina. Sustituye lo que hay, pero antes guarda una copia: **Deshacer la última importación** la recupera.

## Ajustes

Todos se pueden cambiar en un perfil. La columna dice cuáles también por proyecto.

| Ajuste | Por proyecto | Qué hace |
| --- | --- | --- |
| Ejecutar al abrir Orca | no | Si está apagado, solo se ejecuta a mano |
| Espera al abrir Orca | no | Segundos que deja a Orca para cargar antes de empezar |
| Proyectos a la vez | no | Cuántos proyectos se procesan en paralelo |
| Avisar al terminar | no | Notificación con el resumen, y cuando la revisión periódica encuentra commits nuevos |
| Revisar commits nuevos cada | no | Con Orca abierto, revisa cada tantos minutos (0 = nunca) |
| Segundos entre agentes | no | Espera entre abrir un agente y el siguiente |
| Git | sí | Descargar y avanzar · Solo descargar · No tocar git |
| Saltar si hay cambios sin commitear | sí | No trae nada si hay archivos versionados modificados |
| Todas las ramas y limpiar las borradas | sí | `git fetch --all --prune` |
| Actualizar submódulos | sí | `git submodule update --init --recursive` tras avanzar |
| Informar de los demás worktrees | sí | Cuántos commits va por detrás cada uno; no los mueve |
| Agente | sí | Claude, Codex, Copilot, Cursor, OpenCode… |
| Qué hace el agente | sí | Abrirse y esperar · Resumir los commits nuevos · Enviar mi prompt siempre · Retomar la última sesión · No abrir agente |
| Solo si hay commits nuevos | sí | El agente solo se abre donde han entrado commits |
| Prompt de arranque | sí | Variables: `{proyecto}`, `{rama}`, `{remota}`, `{n_commits}`, `{commits}` |
| Instalar dependencias si cambian | sí | Lockfiles de la raíz → `npm install`, `pnpm install`, `yarn install`, `bun install`, `composer install`, `flutter pub get`/`dart pub get`, `bundle install`, `poetry install`, `uv sync` |
| Instalar dependencias si faltan | sí | Sin `node_modules`, `vendor`, `.dart_tool` o `.venv` → su instalación, aunque git no traiga nada |
| Ejecutar los comandos de cada proyecto | sí | Apagado, no se lanza ninguno de sus comandos |

## Qué no hace nunca

- **No mezcla ramas ni hace rebase:** solo avance rápido (`git merge --ff-only --no-autostash @{u}`). Si la rama ha divergido, o si el avance pisaría cambios sin commitear, git se niega y el proyecto queda como estaba.
- **No toca ramas sin remota.**
- **No pide credenciales:** si git las necesita, la descarga falla y se informa.
- **No abre un segundo agente** en un proyecto que ya tiene uno abierto, ni una segunda pestaña de un comando (salvo que pidas reiniciarlo).
- **No repite el arranque** si el worker del plugin se reinicia con Orca abierto. Solo se ejecuta al abrir Orca de nuevo o tras reiniciar el equipo.
- **Solo actúa en el checkout principal** de cada proyecto. Los demás worktrees, como mucho, se consultan.

El prompt se envía en una sola línea: los saltos de línea se convierten en espacios para que el agente no lo reciba a medias.

## Cómo funciona

Orca arranca el worker del plugin en cuanto el plugin está activo (al abrir Orca), porque el manifiesto declara un elemento en la barra de estado. La función `activate` del worker es, por tanto, el momento "al abrir Orca".

| Archivo | Qué hace |
| --- | --- |
| `orca-plugin.json` | Manifiesto: panel, comandos, barra de estado, eventos, ajustes y permisos |
| `src/worker.ts` | Arranque, protección contra repeticiones, perfiles, avance y Detener, historial, revisión periódica, avisos y peticiones del panel |
| `src/run.ts` | Una ejecución: git, dependencias, preparación, worktrees, agente y pestañas, proyecto a proyecto |
| `src/commands.ts` | Los comandos de cada proyecto: lectura segura, título de su pestaña y cuándo toca |
| `src/suggest.ts` | Qué comandos proponer mirando package.json, composer.json, Makefile… |
| `src/cli.ts` | Lo que va por la CLI de Orca: el agente con modelo, los puertos y el navegador |
| `src/profiles.ts` | Perfiles: lectura segura, perfil del día y qué mostrar al terminar |
| `src/transfer.ts` | Exportar e importar, con los proyectos por ruta y nombre |
| `src/git.ts` | Descargar, avanzar, submódulos y commits por traer |
| `src/deps.ts` | Qué instalar (lockfiles que cambiaron o dependencias que faltan) y ejecutarlo |
| `src/settings.ts` | Valores por defecto, validación, herencia por proyecto, campos del panel y variables del prompt |
| `src/tree.ts` | El árbol de carpetas del panel |
| `src/describe.ts` | Los textos del panel, la barra de estado y los avisos |
| `src/panel.tsx` | El panel |
| `src/protocol.ts` | El contrato entre panel y worker |

Permisos que pide:

| Permiso | Para qué |
| --- | --- |
| `workspace:read` | Ver tus proyectos y workspaces, y enterarse de los que se crean o quitan |
| `workspace:write` | Mostrar un proyecto al terminar el arranque |
| `agent:read` | Ver si ya hay un agente abierto |
| `agent:launch` | Abrir o retomar el agente |
| `history:read` | Encontrar tu última sesión (solo títulos y fechas, nunca la conversación) |
| `terminal:send` | Abrir los comandos en sus pestañas, y cerrar las que abrió |
| `notifications:show` | El aviso al terminar |
| `storage:own` y `settings:own` | Guardar la selección, los ajustes propios, los resultados y los ajustes |

El worker corre como proceso de Node con tu usuario (`trusted-worker`): es lo que le permite ejecutar `git` y las instalaciones.

## Desarrollo

```sh
orca plugin validate .     # comprueba el manifiesto, sin ejecutar código
orca plugin test .         # pruebas de src/*.test.ts(x) con orca/testing
orca plugin check .        # dibuja el panel en cada escenario de src/panel.check.ts
orca plugin dev load .     # carga esta carpeta en Orca; recarga al guardar
orca plugin logs local.monstruito   # cargado como carpeta de desarrollo
```

`orca plugin test` y `orca plugin check` ejecutan el código del plugin en tu equipo, fuera del sandbox de Orca.
