-- =============================================================================
-- Private storage bucket for message attachments.
--
-- Path convention: <workspace_id>/<message_id>/<uuid>-<filename>
--   * The bucket is PRIVATE (no public URLs). Downloads use short-lived signed
--     URLs minted server-side after an authorization check.
--   * Uploads are performed ONLY by the server with the service role (which
--     bypasses RLS); there is intentionally no INSERT/UPDATE/DELETE policy for
--     end users.
--   * Reads are allowed only when the caller can see the matching row in
--     public.attachments (which itself is protected by messages RLS: mailbox
--     access + author-only drafts). Platform admins get no access.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 26214400, null)   -- 25 MiB
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create policy attachments_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.attachments a
      where a.storage_path = storage.objects.name
    )
  );
