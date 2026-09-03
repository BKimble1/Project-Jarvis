import { ValidationError } from '@/domain/errors';
import {
  ALLOWED_UPLOAD_TYPES,
  safeFilename,
  uploadMetadataSchema,
} from '@/domain/knowledge-source';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Upload a document.
 *
 * Multipart rather than base64-in-JSON, so the bytes are never held twice and never pass through
 * a JSON parser. Several things this route deliberately does *not* accept:
 *
 *  - **A storage path.** Where a file is kept is decided server-side. A client-supplied path is
 *    how an upload endpoint becomes a write-anywhere primitive.
 *  - **A declared kind.** The parser registry decides from the bytes and the extension together,
 *    with the stricter of the two winning. A content type is whatever the client felt like
 *    sending, so it is a hint, never proof.
 *  - **An archive.** Nothing here unpacks anything. A zip is refused as an unsupported type
 *    rather than expanded, because expanding attacker-controlled archives is a category of bug
 *    rather than a feature.
 *
 * The filename is passed through `safeFilename` before it reaches storage or provenance, so a
 * name containing `../` becomes an ordinary string rather than a path.
 */
export const POST = ownerRoute(async ({ services, request, session }) => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ValidationError('Upload the file as a form, not as JSON.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError('That upload could not be read.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new ValidationError('Choose a file to upload.');
  }

  const metadata = uploadMetadataSchema.safeParse({
    title: form.get('title') ?? file.name,
    scope: form.get('scope') ?? 'global',
    projectId: form.get('projectId') || null,
    sensitivity: form.get('sensitivity') ?? 'internal',
    tags: [],
  });
  if (!metadata.success) {
    throw new ValidationError('Some fields need attention.', {
      fields: metadata.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      })),
    });
  }

  /*
   * Refuse early on the declared type, before reading the body into memory. This is a cheap first
   * gate, not the real one: the parser still decides from the bytes, so a PDF renamed to .md is
   * caught there rather than here.
   */
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared && !(declared in ALLOWED_UPLOAD_TYPES)) {
    throw new ValidationError(
      `Jarvis reads Markdown, plain text and PDF. It cannot read ${declared}.`,
    );
  }

  const maxBytes = services.config.limits.maxUploadBytes;
  if (file.size > maxBytes) {
    throw new ValidationError(
      `That file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB Jarvis accepts.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  /* Checked again against the real length: `file.size` is a claim until the body is read. */
  if (bytes.byteLength > maxBytes) {
    throw new ValidationError(
      `That file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB Jarvis accepts.`,
    );
  }

  const actor = session.githubLogin ?? session.id;
  const filename = safeFilename(file.name);

  const outcome = await services.ingestion.addUpload({
    /*
     * A placeholder the service never reads. `addUpload` derives the real kind from the declared
     * type and the extension together and refuses when they disagree, so nothing the client sends
     * decides how its own file is treated.
     */
    kind: 'plain_text',
    title: metadata.data.title,
    scope: metadata.data.scope,
    projectId: metadata.data.projectId ?? null,
    sensitivity: metadata.data.sensitivity,
    addedBy: actor,
    tags: metadata.data.tags,
    bytes,
    filename,
    contentType: file.type || null,
  });

  await services.audit.append({
    actor,
    actorKind: 'owner',
    action: 'source.add',
    subjectKind: 'knowledge_source',
    subjectId: outcome.sourceId,
    projectId: metadata.data.projectId ?? null,
    outcome: 'allowed',
    rule: 'R-SR1',
    summary: `You uploaded “${metadata.data.title}”.`,
    /* The sanitised filename, the size and the counts. Never a line of the document. */
    detail: {
      filename,
      byteSize: bytes.byteLength,
      declaredType: file.type || null,
      chunkCount: outcome.chunkCount,
      revisionState: outcome.state,
    },
  });

  return json(outcome, { status: 201 });
});
