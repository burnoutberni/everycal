#!/bin/sh
# Run HTTP server in background. If RUN_JOBS_INTERNALLY=true, run job runner (scrapers + reminders).
# Jobs use JOBS_API_SERVER. Set RUN_JOBS_INTERNALLY=false to run server only.
set -e
node packages/server/dist/index.js &
SERVER_PID=$!
case "${RUN_JOBS_INTERNALLY:-true}" in
  false|0|no) wait $SERVER_PID ;;
  *) sleep 2; exec node packages/jobs/dist/index.js all ;;
esac
