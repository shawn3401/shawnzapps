-- Your Turn: which way a meal was decided, so each way keeps its own rotation per group.
-- 'turns' = one person picks; 'elim' = everyone eliminates and the last person picks. Null = nobody picked. Safe to re-run.
alter table public.yourturn_visits add column if not exists mode text check (mode in ('turns','elim'));
