export * from '../../scripts/config'
import { runConfigCli } from '../../scripts/config'

if (import.meta.main) {
  await runConfigCli()
}
