#!/bin/bash

# Copilot API - Development Startup Script

set -e

export PATH="/root/.bun/bin:$PATH"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo -e "${RED}❌ Bun is not installed${NC}"
    echo "Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo -e "${BLUE}🚀 Copilot API Startup${NC}"
echo -e "${BLUE}Bun version: $(bun --version)${NC}"
echo ""

# Load .env file if it exists
load_env_file() {
    local env_file="$1"
    if [ -f "$env_file" ]; then
        echo -e "${GREEN}📝 Loading configuration from $env_file${NC}"
        set -o allexport
        source "$env_file"
        set +o allexport
    fi
}

# Load .env and .env.local
load_env_file ".env"
load_env_file ".env.local"

# Default values (can be overridden by .env)
PORT=${PORT:-4141}
VERBOSE=${VERBOSE:-false}
API_KEY="${API_KEY:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ACCOUNT_TYPE=${ACCOUNT_TYPE:-individual}
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
MODE="dev"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port|-p)
            PORT="$2"
            shift 2
            ;;
        --api-key)
            API_KEY="$2"
            shift 2
            ;;
        --admin-password)
            ADMIN_PASSWORD="$2"
            shift 2
            ;;
        --github-token)
            GITHUB_TOKEN="$2"
            shift 2
            ;;
        --account-type|-a)
            ACCOUNT_TYPE="$2"
            shift 2
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --prod)
            MODE="prod"
            shift
            ;;
        --help|-h)
            echo "Usage: ./start-dev.sh [options]"
            echo ""
            echo "Options:"
            echo "  --port, -p PORT           Port to listen on (default: 4141)"
            echo "  --api-key KEY             API key for Bearer auth"
            echo "  --admin-password PASS     Admin dashboard password"
            echo "  --github-token TOKEN      GitHub token (skip auth prompt)"
            echo "  --account-type, -a TYPE   individual|business|enterprise (default: individual)"
            echo "  --verbose, -v             Enable verbose logging"
            echo "  --prod                    Run in production mode"
            echo "  --help, -h                Show this help"
            echo ""
            echo "Examples:"
            echo "  ./start-dev.sh"
            echo "  ./start-dev.sh --port 8080 --verbose"
            echo "  ./start-dev.sh --api-key sk-123 --admin-password secret"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Build command
declare -a CMD_ARGS=("start")

# Add options
if [ "$VERBOSE" = true ]; then
    CMD_ARGS+=("--verbose")
fi

if [ -n "$PORT" ]; then
    CMD_ARGS+=("--port" "$PORT")
fi

if [ -n "$ACCOUNT_TYPE" ]; then
    CMD_ARGS+=("--account-type" "$ACCOUNT_TYPE")
fi

if [ -n "$API_KEY" ]; then
    CMD_ARGS+=("--api-key" "$API_KEY")
fi

if [ -n "$ADMIN_PASSWORD" ]; then
    CMD_ARGS+=("--admin-password" "$ADMIN_PASSWORD")
fi

if [ -n "$GITHUB_TOKEN" ]; then
    CMD_ARGS+=("--github-token" "$GITHUB_TOKEN")
fi

# Display config
echo -e "${GREEN}Configuration:${NC}"
echo "  Mode:           $MODE"
echo "  Port:           $PORT"
echo "  Verbose:        $VERBOSE"
echo "  Account Type:   $ACCOUNT_TYPE"
[ -n "$API_KEY" ] && echo "  API Key:        ✅ Configured"
[ -n "$ADMIN_PASSWORD" ] && echo "  Admin Password: ✅ Configured"
[ -n "$GITHUB_TOKEN" ] && echo "  GitHub Token:   ✅ Provided"
echo ""

# Show access URLs
if [ "$MODE" = "dev" ]; then
    echo -e "${YELLOW}📍 Starting in development mode (auto-reload)${NC}"
else
    echo -e "${YELLOW}📍 Starting in production mode${NC}"
fi
echo ""

if [ -n "$API_KEY" ]; then
    echo -e "${GREEN}🔐 API Protection Enabled${NC}"
    echo "  Admin Login:  http://localhost:$PORT/admin/login"
    echo "  Usage Stats:  http://localhost:$PORT/usage"
    echo ""
fi

echo -e "${GREEN}📊 Server will start on http://localhost:$PORT${NC}"
echo -e "${GREEN}Press Ctrl+C to stop${NC}"
echo ""

# Run the command
if [ "$MODE" = "prod" ]; then
    NODE_ENV=production bun ./src/main.ts "${CMD_ARGS[@]}"
else
    bun --watch ./src/main.ts "${CMD_ARGS[@]}"
fi
