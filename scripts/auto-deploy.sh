#!/bin/bash
# Auto-deploy: polls GitHub for new commits on master and deploys automatically
# Runs as a PM2 service, checks every 60 seconds

REPO_DIR="/home/edouard/claude-telegram-relay"
LOG_PREFIX="[auto-deploy]"
BRANCH="master"
CHECK_INTERVAL=60

cd "$REPO_DIR" || exit 1

echo "$LOG_PREFIX Starting auto-deploy watcher on branch $BRANCH"

while true; do
    # Fetch latest from remote
    git fetch origin "$BRANCH" --quiet 2>/dev/null

    LOCAL=$(git rev-parse "$BRANCH" 2>/dev/null)
    REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)

    if [ "$LOCAL" != "$REMOTE" ]; then
        echo "$LOG_PREFIX New commits detected on $BRANCH"
        echo "$LOG_PREFIX Local:  $LOCAL"
        echo "$LOG_PREFIX Remote: $REMOTE"

        # Pull changes
        git checkout "$BRANCH" --quiet 2>/dev/null
        git pull origin "$BRANCH" --quiet

        if [ $? -eq 0 ]; then
            echo "$LOG_PREFIX Pull successful"

            # Install dependencies if package.json changed
            if git diff --name-only "$LOCAL" "$REMOTE" | grep -q "package.json"; then
                echo "$LOG_PREFIX package.json changed, running bun install"
                bun install
            fi

            # Restart relay and dashboard
            echo "$LOG_PREFIX Restarting PM2 services"
            npx pm2 restart claude-relay --update-env 2>/dev/null
            npx pm2 restart claude-dashboard --update-env 2>/dev/null

            COMMIT=$(git log --oneline -1)
            echo "$LOG_PREFIX Deploy complete: $COMMIT"

            # Notify serveur topic
            bash "$REPO_DIR/scripts/notify-deploy.sh" "success" "$COMMIT"
        else
            echo "$LOG_PREFIX ERROR: git pull failed"

            # Notify deploy failure
            bash "$REPO_DIR/scripts/notify-deploy.sh" "failure" "git pull failed on $BRANCH"
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
