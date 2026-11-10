-- ============================================================
-- 让后端在你没开 App 时也会「醒来」看看要不要说话
-- 在 Supabase → SQL Editor 里整段粘贴执行一次即可
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 如果之前建过同名任务，先删掉（可以重复执行）
select cron.unschedule('bunny-heartbeat')
where exists (select 1 from cron.job where jobname = 'bunny-heartbeat');

-- 每 10 分钟敲一次心跳接口
select cron.schedule(
  'bunny-heartbeat',
  '*/10 * * * *',
  $$
  select net.http_get(
    url := 'https://f-home-api.onrender.com/api/heartbeat',
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);

-- 查看是否排上了
-- select * from cron.job;

-- 想看每次请求的结果
-- select status_code, created from net._http_response order by created desc limit 10;

-- 想停掉：
-- select cron.unschedule('bunny-heartbeat');
