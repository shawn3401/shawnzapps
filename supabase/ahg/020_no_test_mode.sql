-- No test mode (Shawn, Oct 22, 2026): a new report email is tested by first sending it to a few
-- people, then adding the rest. Emails still in test mode keep doing what they did: they now go
-- live to their test address only. (Daily Leadership Reports had execs@, trevor@, and aaron@
-- waiting; Shawn adds them back when ready.) Safe to re-run.
set client_min_messages = warning;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'report_distributions' and column_name = 'mode') then
    update public.report_distributions set recipients = array[test_to], audiences = '{}' where mode = 'test';
    alter table public.report_distributions drop column mode;
    alter table public.report_distributions drop column test_to;
  end if;
end $$;
notify pgrst, 'reload schema';
