-- Draft capture — permanent store for the live draft-room event stream that
-- the Keeper Edge extension captures (nominations, every bid, passes, sales,
-- socket opens/closes, unknown frames). This is the raw data behind the
-- owner-tendency analysis planned for after the 2027 draft.
--
-- Lives in The League App's Supabase project (fbllfkrtjsihrkwnbmlw), but the
-- data is Ultimate Draft's alone: Jeff-only RLS (owner id 'jeff'), because
-- Ultimate Draft is a single-user tool and this is his scouting data.
--
-- Re-runnable.

create table if not exists public.draft_sessions (
  id          uuid primary key default gen_random_uuid(),
  -- "<leagueId>:<startedAtMs>" from the extension's event log — device-
  -- independent natural key so reloads/second devices upsert, never duplicate.
  client_key  text not null unique,
  league_id   text not null,
  sport       text,                                -- 'flb' | 'ffl'
  season      integer,
  is_mock     boolean not null default true,        -- bot mocks must NEVER mix into human tendency data
  label       text,
  started_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table if not exists public.draft_events (
  session_id      uuid not null references public.draft_sessions(id) on delete cascade,
  seq             integer not null,                 -- extension-assigned, monotonic per session
  cmd             text not null,                    -- SOLD | BID | BID_ACK | NOMINATION | PASSED | INIT | SOCKET_* | <unknown>
  espn_team_id    integer,
  espn_player_id  integer,
  amount          integer,                          -- bid/sale $ where the frame carries one
  raw             text,                             -- raw frame text (truncated) — lets us re-parse later as the protocol is understood better
  captured_at     timestamptz,                      -- when the extension saw the frame
  inserted_at     timestamptz not null default now(),
  primary key (session_id, seq)                     -- makes client re-uploads idempotent
);

create index if not exists draft_events_player_idx on public.draft_events (espn_player_id);
create index if not exists draft_events_cmd_idx    on public.draft_events (session_id, cmd);

alter table public.draft_sessions enable row level security;
alter table public.draft_events   enable row level security;

-- Jeff-only. public.my_team_id() already exists (used by league_votes RLS).
drop policy if exists ds_jeff_all on public.draft_sessions;
create policy ds_jeff_all on public.draft_sessions for all
  using (public.my_team_id() = 'jeff') with check (public.my_team_id() = 'jeff');

drop policy if exists de_jeff_all on public.draft_events;
create policy de_jeff_all on public.draft_events for all
  using (public.my_team_id() = 'jeff') with check (public.my_team_id() = 'jeff');

-- 2026-07-05: this project revokes default table privileges, so the original
-- migration left the tables unreadable/unwritable by EVERY role — the app's
-- mirror failed silently until these grants were applied.
grant select, insert, update on public.draft_sessions to authenticated;
grant select, insert on public.draft_events to authenticated;
grant select on public.draft_sessions, public.draft_events to service_role;
