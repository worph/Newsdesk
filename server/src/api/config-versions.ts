import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth.js'
import {
  ConfigRejected,
  configToYaml,
  getConfigVersion,
  listConfigVersions,
  previewRestore,
  restoreConfigVersion,
} from '../config/store.js'
import type { Db } from '../db/index.js'
import { logEvent } from '../events.js'

/**
 * The way back from a configuration change.
 *
 * Restore is deliberately a three-step affair — list, preview, then restore —
 * rather than a single button. `inUse` can refuse a restore outright, and
 * removing an endpoint destroys an OAuth token that no snapshot holds, so the
 * preview is not a nicety: it is where the consequences that cannot be undone
 * are stated before anyone commits to them.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() })

export function registerConfigVersionRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/v1/config/versions', { preHandler: requireSession }, async () => ({
    versions: listConfigVersions(db),
  }))

  app.get('/api/v1/config/versions/:id', { preHandler: requireSession }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a version id is required' })

    const version = getConfigVersion(db, parsed.data.id)
    if (!version) return reply.code(404).send({ error: 'no such configuration version' })
    return version
  })

  app.get('/api/v1/config/versions/:id/preview', { preHandler: requireSession }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a version id is required' })

    const preview = previewRestore(db, parsed.data.id)
    if (!preview) return reply.code(404).send({ error: 'no such configuration version' })
    return preview
  })

  app.post('/api/v1/config/versions/:id/restore', { preHandler: requireSession }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'a version id is required' })

    const version = getConfigVersion(db, parsed.data.id)
    if (!version) return reply.code(404).send({ error: 'no such configuration version' })

    try {
      const config = restoreConfigVersion(db, parsed.data.id)
      logEvent(db, {
        level: 'info',
        actor: 'human',
        code: 'CONFIG_RESTORED',
        message: `you rolled the configuration back to how it stood at ${version.at}`,
        detail: { author: 'restore', restoredFromId: parsed.data.id },
      })
      return { ok: true, yaml: configToYaml(config), config }
    } catch (err) {
      if (err instanceof ConfigRejected) {
        // Nothing was written: `writeConfig` validates before it opens the
        // transaction, so a refused restore leaves the desk exactly as it was.
        return reply.code(422).send({ error: 'that version cannot be restored', issues: err.issues })
      }
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}
