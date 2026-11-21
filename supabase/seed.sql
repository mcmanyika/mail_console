-- =============================================================================
-- Mail Console — DEMO seed data (applied by `supabase db reset`)
--
-- Everything here is synthetic:
--   * all hostnames use the reserved `.example` TLD (RFC 2606) — they can never
--     resolve or receive real mail;
--   * all provider IDs are prefixed `demo_` / `mock_`;
--   * run the app with DEMO_MODE=true so the mock Resend adapter is used and NO
--     real email is ever sent.
--
-- Demo login password for every user: demo-password-123
--
--   admin@mailconsole.example         platform admin (NOT a workspace member:
--                                     can manage workspaces, cannot read mail)
--   maya@overflowconnections.example  Overflow Connections — owner
--   jon@overflowconnections.example   Overflow Connections — member
--                                       support@  read_send, hello@  read
--   david@profaith.example            ProFaith — owner
--   grace@profaith.example            ProFaith — admin
--   hannah@profaith.example           ProFaith — member (prayer@ read_send)
--   lena@langprofile.example          LangProfile — owner
--   sam@langprofile.example           LangProfile — member (support@ read only)
--
-- Demo API key for Overflow Connections (transactional API):
--   mck_demo0001_demo-secret-do-not-use-0000000000
-- (hashed with the dev pepper 'mail-console-dev-pepper' — see src/lib/crypto)
-- Demo invitation token for newcomer@example.com -> ProFaith:
--   demo-invite-token-profaith-0000000000
-- =============================================================================

-- ---- auth users -------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('demo-password-123', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name),
  now(), now(), '', '', '', ''
from (values
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'admin@mailconsole.example',        'Avery Admin'),
  ('a0000000-0000-4000-8000-000000000002'::uuid, 'maya@overflowconnections.example', 'Maya Okafor'),
  ('a0000000-0000-4000-8000-000000000003'::uuid, 'jon@overflowconnections.example',  'Jon Whitfield'),
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'david@profaith.example',           'David Reyes'),
  ('a0000000-0000-4000-8000-000000000005'::uuid, 'grace@profaith.example',           'Grace Liu'),
  ('a0000000-0000-4000-8000-000000000006'::uuid, 'hannah@profaith.example',          'Hannah Brooks'),
  ('a0000000-0000-4000-8000-000000000007'::uuid, 'lena@langprofile.example',         'Lena Novak'),
  ('a0000000-0000-4000-8000-000000000008'::uuid, 'sam@langprofile.example',          'Sam Patel')
) as u(id, email, full_name)
on conflict (id) do nothing;

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users u
where u.email like '%.example'
  and not exists (select 1 from auth.identities i where i.user_id = u.id);

-- profiles are created by the on_auth_user_created trigger.

insert into public.platform_admins (user_id)
values ('a0000000-0000-4000-8000-000000000001')
on conflict do nothing;

-- ---- workspaces -------------------------------------------------------------
insert into public.workspaces (id, name, slug, status, monthly_sending_limit) values
  ('b0000000-0000-4000-8000-000000000001', 'Overflow Connections', 'overflow-connections', 'active', 5000),
  ('b0000000-0000-4000-8000-000000000002', 'ProFaith',             'profaith',             'active', 3000),
  ('b0000000-0000-4000-8000-000000000003', 'LangProfile',          'langprofile',          'active', 50);

insert into public.workspace_memberships (id, workspace_id, user_id, role) values
  ('90000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'owner'),
  ('90000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'member'),
  ('90000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000004', 'owner'),
  ('90000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000005', 'admin'),
  ('90000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000006', 'member'),
  ('90000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000007', 'owner'),
  ('90000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000008', 'member');

insert into public.workspace_invitations (workspace_id, email, role, token_hash, expires_at, invited_by)
values (
  'b0000000-0000-4000-8000-000000000002', 'newcomer@example.com', 'member',
  encode(extensions.hmac('demo-invite-token-profaith-0000000000', 'mail-console-dev-pepper', 'sha256'), 'hex'),
  now() + interval '7 days', 'a0000000-0000-4000-8000-000000000004'
);

-- ---- domains ----------------------------------------------------------------
insert into public.domains (id, workspace_id, hostname, resend_domain_id, send_status, inbound_status, dns_records, last_checked_at) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'overflowconnections.example', 'mock_domain_overflow', 'verified', 'verified',
    '[{"record":"SPF","name":"send","type":"TXT","value":"v=spf1 include:amazonses.com ~all","ttl":"Auto","status":"verified"},
      {"record":"DKIM","name":"resend._domainkey","type":"TXT","value":"p=DEMO_DKIM_PUBLIC_KEY","ttl":"Auto","status":"verified"},
      {"record":"Receiving","name":"@","type":"MX","value":"inbound-smtp.mock.example","ttl":"Auto","status":"verified","priority":10}]'::jsonb, now()),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'profaith.example', 'mock_domain_profaith', 'verified', 'verified',
    '[{"record":"SPF","name":"send","type":"TXT","value":"v=spf1 include:amazonses.com ~all","ttl":"Auto","status":"verified"},
      {"record":"DKIM","name":"resend._domainkey","type":"TXT","value":"p=DEMO_DKIM_PUBLIC_KEY","ttl":"Auto","status":"verified"},
      {"record":"Receiving","name":"@","type":"MX","value":"inbound-smtp.mock.example","ttl":"Auto","status":"verified","priority":10}]'::jsonb, now()),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'langprofile.example', 'mock_domain_langprofile', 'verified', 'pending',
    '[{"record":"SPF","name":"send","type":"TXT","value":"v=spf1 include:amazonses.com ~all","ttl":"Auto","status":"verified"},
      {"record":"DKIM","name":"resend._domainkey","type":"TXT","value":"p=DEMO_DKIM_PUBLIC_KEY","ttl":"Auto","status":"verified"},
      {"record":"Receiving","name":"@","type":"MX","value":"inbound-smtp.mock.example","ttl":"Auto","status":"pending","priority":10}]'::jsonb, now());

-- ---- mailboxes --------------------------------------------------------------
insert into public.mailboxes (id, workspace_id, domain_id, address, display_name) values
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'support@overflowconnections.example', 'Overflow Support'),
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'hello@overflowconnections.example',   'Overflow Hello'),
  ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'prayer@profaith.example',               'ProFaith Prayer Team'),
  ('d0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'hello@profaith.example',                'ProFaith Hello'),
  ('d0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'support@langprofile.example',           'LangProfile Support'),
  ('d0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'billing@langprofile.example',           'LangProfile Billing');

-- Explicit grants required for ALL roles (including owners/admins) to read mail.
insert into public.mailbox_access (workspace_id, membership_id, mailbox_id, permission) values
  -- Overflow: Maya (owner) + Jon (member)
  ('b0000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'read_send'),
  ('b0000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'read_send'),
  ('b0000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'read_send'),
  ('b0000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'read'),
  -- ProFaith: David (owner), Grace (admin), Hannah (member)
  ('b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003', 'read_send'),
  ('b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000004', 'read_send'),
  ('b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000003', 'read_send'),
  ('b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004', 'read_send'),
  ('b0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000003', 'read_send'),
  -- LangProfile: Lena (owner), Sam (member, read-only on support)
  ('b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000005', 'read_send'),
  ('b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000006', 'read_send'),
  ('b0000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000005', 'read');

-- ---- threads ----------------------------------------------------------------
insert into public.threads (id, workspace_id, mailbox_id, subject, normalized_subject, last_activity_at) values
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Question about connection requests', 'question about connection requests', now() - interval '3 days'),
  ('e0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Partnership inquiry',                'partnership inquiry',                now() - interval '1 day'),
  ('e0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'Hello from a new member',            'hello from a new member',            now() - interval '5 hours'),
  ('e0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000003', 'Prayer request (synthetic demo)',    'prayer request (synthetic demo)',    now() - interval '2 days'),
  ('e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000004', 'Volunteering at the next event',    'volunteering at the next event',     now() - interval '6 hours'),
  ('e0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000005', 'Cannot upload my profile video',    'cannot upload my profile video',     now() - interval '4 hours'),
  ('e0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000006', 'Invoice question',                  'invoice question',                   now() - interval '2 days');

-- ---- messages ---------------------------------------------------------------
-- Inbound
insert into public.messages (id, workspace_id, thread_id, mailbox_id, direction, lifecycle_state, from_address, subject, snippet, text_body, html_body, resend_email_id, rfc_message_id, received_at, created_at) values
  ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'inbound', 'received',
   'Priya Shah <priya@customer-one.example>', 'Question about connection requests', 'Hi, how many connection requests can I send per week?',
   E'Hi,\n\nHow many connection requests can I send per week on the free plan?\n\nThanks,\nPriya', '<p>Hi,</p><p>How many connection requests can I send per week on the free plan?</p><p>Thanks,<br>Priya</p>',
   'demo_in_0001', '<demo-in-0001@customer-one.example>', now() - interval '3 days', now() - interval '3 days'),
  ('f0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'inbound', 'received',
   'Tom Becker <tom@partner-co.example>', 'Partnership inquiry', 'We would love to explore a partnership with Overflow Connections.',
   E'Hello team,\n\nWe would love to explore a partnership with Overflow Connections. Do you have 20 minutes this week?\n\nBest,\nTom', '<p>Hello team,</p><p>We would love to explore a partnership with Overflow Connections. Do you have 20 minutes this week?</p><p>Best,<br>Tom</p>',
   'demo_in_0002', '<demo-in-0002@partner-co.example>', now() - interval '1 day', now() - interval '1 day'),
  ('f0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', 'inbound', 'received',
   'Nina Alvarez <nina@member.example>', 'Hello from a new member', 'Just joined and wanted to say hi!',
   E'Just joined and wanted to say hi!', '<p>Just joined and wanted to say hi!</p>',
   'demo_in_0003', '<demo-in-0003@member.example>', now() - interval '5 hours', now() - interval '5 hours'),
  ('f0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000003', 'inbound', 'received',
   'Elena Park <elena@supporter.example>', 'Prayer request (synthetic demo)', 'This is synthetic demo content.',
   E'This is synthetic demo content for a sensitive-looking inbox. No real person wrote this.', '<p>This is synthetic demo content for a sensitive-looking inbox. No real person wrote this.</p>',
   'demo_in_0004', '<demo-in-0004@supporter.example>', now() - interval '2 days', now() - interval '2 days'),
  ('f0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000004', 'inbound', 'received',
   'Marcus Hill <marcus@volunteer.example>', 'Volunteering at the next event', 'I would like to help at the next community event.',
   E'I would like to help at the next community event. What do I need to bring?', '<p>I would like to help at the next community event. What do I need to bring?</p>',
   'demo_in_0005', '<demo-in-0005@volunteer.example>', now() - interval '6 hours', now() - interval '6 hours'),
  ('f0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000005', 'inbound', 'received',
   'Yuki Tanaka <yuki@learner.example>', 'Cannot upload my profile video', 'The upload spinner never finishes.',
   E'The upload spinner never finishes on my profile video (12 MB). Any ideas?', '<p>The upload spinner never finishes on my profile video (12 MB). Any ideas?</p>',
   'demo_in_0006', '<demo-in-0006@learner.example>', now() - interval '4 hours', now() - interval '4 hours'),
  ('f0000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000006', 'inbound', 'received',
   'Omar Haddad <omar@learner.example>', 'Invoice question', 'Could you resend my last invoice?',
   E'Could you resend my last invoice? Thanks!', '<p>Could you resend my last invoice? Thanks!</p>',
   'demo_in_0007', '<demo-in-0007@learner.example>', now() - interval '2 days', now() - interval '2 days');

-- Outbound reply (already "submitted" through the mock adapter)
insert into public.messages (id, workspace_id, thread_id, mailbox_id, direction, lifecycle_state, from_address, subject, snippet, text_body, html_body, resend_email_id, rfc_message_id, in_reply_to, references_header, author_user_id, sent_at, created_at) values
  ('f0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'outbound', 'submitted',
   'Overflow Support <support@overflowconnections.example>', 'Re: Question about connection requests', 'Great question! The free plan allows 50 requests per week.',
   E'Great question! The free plan allows 50 requests per week.\n\n— Maya', '<p>Great question! The free plan allows 50 requests per week.</p><p>— Maya</p>',
   'mock_out_0001', '<demo-out-0001@overflowconnections.example>', '<demo-in-0001@customer-one.example>', '<demo-in-0001@customer-one.example>',
   'a0000000-0000-4000-8000-000000000002', now() - interval '3 days' + interval '1 hour', now() - interval '3 days' + interval '1 hour');

-- Drafts (visible only to their author)
insert into public.messages (id, workspace_id, thread_id, mailbox_id, direction, lifecycle_state, from_address, subject, snippet, text_body, author_user_id, in_reply_to, references_header) values
  ('f0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'draft', 'draft',
   'Overflow Support <support@overflowconnections.example>', 'Re: Partnership inquiry', 'Thanks Tom — Thursday works.',
   E'Thanks Tom — Thursday at 2pm works. (maya''s private draft)', 'a0000000-0000-4000-8000-000000000002',
   '<demo-in-0002@partner-co.example>', '<demo-in-0002@partner-co.example>'),
  ('f0000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000002', null, 'd0000000-0000-4000-8000-000000000003', 'draft', 'draft',
   'ProFaith Prayer Team <prayer@profaith.example>', 'Checking in', 'Just checking in this week.',
   E'Just checking in this week. (hannah''s private draft)', 'a0000000-0000-4000-8000-000000000006', null, null);

insert into public.message_recipients (message_id, workspace_id, address, type, delivery_state) values
  ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'support@overflowconnections.example', 'to', 'received'),
  ('f0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'priya@customer-one.example',          'to', 'delivered'),
  ('f0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'support@overflowconnections.example', 'to', 'received'),
  ('f0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'hello@overflowconnections.example',   'to', 'received'),
  ('f0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'prayer@profaith.example',              'to', 'received'),
  ('f0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000002', 'hello@profaith.example',               'to', 'received'),
  ('f0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000003', 'support@langprofile.example',          'to', 'received'),
  ('f0000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000003', 'billing@langprofile.example',          'to', 'received'),
  ('f0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000001', 'tom@partner-co.example',               'to', 'pending'),
  ('f0000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000002', 'elena@supporter.example',              'to', 'pending');

-- Per-user thread state (maya has read thread 1, jon has not)
insert into public.thread_user_state (workspace_id, thread_id, user_id, is_read, is_archived) values
  ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', true,  false),
  ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', false, false);

-- ---- templates --------------------------------------------------------------
insert into public.email_templates (workspace_id, name, subject, body_text, body_html, variables) values
  ('b0000000-0000-4000-8000-000000000001', 'Welcome', 'Welcome to Overflow Connections, {{first_name}}!',
   E'Hi {{first_name}},\n\nWelcome aboard!', '<p>Hi {{first_name}},</p><p>Welcome aboard!</p>', '["first_name"]'::jsonb),
  ('b0000000-0000-4000-8000-000000000002', 'Event follow-up', 'Thanks for joining {{event_name}}',
   E'Hi {{first_name}},\n\nThanks for joining {{event_name}}.', '<p>Hi {{first_name}},</p><p>Thanks for joining {{event_name}}.</p>', '["first_name","event_name"]'::jsonb),
  ('b0000000-0000-4000-8000-000000000003', 'Support acknowledgement', 'We received your request',
   E'Hi {{first_name}},\n\nWe got your message and will reply within one business day.', '<p>Hi {{first_name}},</p><p>We got your message and will reply within one business day.</p>', '["first_name"]'::jsonb);

-- ---- API integration (demo key, see header) ---------------------------------
insert into public.app_integrations (workspace_id, name, allowed_mailbox_id, key_hash, key_prefix, created_by) values
  ('b0000000-0000-4000-8000-000000000001', 'Overflow app transactional mail', 'd0000000-0000-4000-8000-000000000002',
   encode(extensions.hmac('mck_demo0001_demo-secret-do-not-use-0000000000', 'mail-console-dev-pepper', 'sha256'), 'hex'),
   'mck_demo0001', 'a0000000-0000-4000-8000-000000000002');

-- ---- usage & audit ----------------------------------------------------------
insert into public.monthly_usage (workspace_id, year_month, reserved_count, settled_count) values
  ('b0000000-0000-4000-8000-000000000001', to_char(now() at time zone 'utc', 'YYYY-MM'), 0, 312),
  ('b0000000-0000-4000-8000-000000000002', to_char(now() at time zone 'utc', 'YYYY-MM'), 0, 87),
  ('b0000000-0000-4000-8000-000000000003', to_char(now() at time zone 'utc', 'YYYY-MM'), 2, 46);   -- 48/50: quota demo

insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'workspace.activated', 'workspace', 'b0000000-0000-4000-8000-000000000001', '{"source":"seed"}'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'workspace.activated', 'workspace', 'b0000000-0000-4000-8000-000000000002', '{"source":"seed"}'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'workspace.activated', 'workspace', 'b0000000-0000-4000-8000-000000000003', '{"source":"seed"}');
