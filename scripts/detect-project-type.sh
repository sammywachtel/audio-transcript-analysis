#!/bin/bash

# Project Detection Script for Adaptive Quality Gate Template
# Intelligently detects project structure, languages, and technologies

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables for detection results
PROJECT_TYPE=""
HAS_FRONTEND=false
HAS_BACKEND=false
HAS_TYPESCRIPT=false
HAS_JAVASCRIPT=false
HAS_PYTHON=false
HAS_REACT=false
HAS_FASTAPI=false
HAS_TESTS=false
FRONTEND_PATH=""
BACKEND_PATH=""

# Function to print debug info
debug_print() {
    if [[ "${DEBUG:-false}" == "true" ]]; then
        echo -e "${BLUE}[DEBUG]${NC} $1" >&2
    fi
}

# Function to check if a directory contains specific files/patterns
contains_files() {
    local pattern="$1"
    local path="${2:-.}"

    if [[ -d "$path" ]]; then
        find "$path" -maxdepth 3 -name "$pattern" -type f 2>/dev/null | head -1 | grep -q .
    else
        false
    fi
}

# Function to check if package.json contains specific dependencies
has_npm_dependency() {
    local dependency="$1"
    local package_json="${2:-package.json}"

    if [[ -f "$package_json" ]]; then
        jq -r '.dependencies // {}, .devDependencies // {} | keys[]' "$package_json" 2>/dev/null | grep -q "^${dependency}$"
    else
        false
    fi
}

# Function to check if requirements.txt contains specific packages
has_python_dependency() {
    local dependency="$1"
    local requirements="${2:-requirements.txt}"

    if [[ -f "$requirements" ]]; then
        grep -i "^${dependency}" "$requirements" >/dev/null 2>&1
    else
        false
    fi
}

# Detect frontend presence and technology
detect_frontend() {
    debug_print "Detecting frontend..."

    # Check for common frontend directory structures
    if [[ -d "frontend" ]]; then
        FRONTEND_PATH="frontend"
        HAS_FRONTEND=true
        debug_print "Found frontend directory"
    elif [[ -d "src" && (-f "package.json" || -f "src/App.tsx" || -f "src/App.jsx") ]]; then
        FRONTEND_PATH="."
        HAS_FRONTEND=true
        debug_print "Found frontend in root directory"
    elif [[ -d "client" ]]; then
        FRONTEND_PATH="client"
        HAS_FRONTEND=true
        debug_print "Found client directory"
    fi

    # Check for TypeScript
    if contains_files "*.ts" "$FRONTEND_PATH" || contains_files "*.tsx" "$FRONTEND_PATH"; then
        HAS_TYPESCRIPT=true
        debug_print "TypeScript detected"
    fi

    # Check for JavaScript
    if contains_files "*.js" "$FRONTEND_PATH" || contains_files "*.jsx" "$FRONTEND_PATH"; then
        HAS_JAVASCRIPT=true
        debug_print "JavaScript detected"
    fi

    # Check for React
    local package_json_path="$FRONTEND_PATH/package.json"
    if [[ "$FRONTEND_PATH" == "." ]]; then
        package_json_path="package.json"
    fi

    if has_npm_dependency "react" "$package_json_path"; then
        HAS_REACT=true
        debug_print "React detected"
    fi
}

# Detect backend presence and technology
detect_backend() {
    debug_print "Detecting backend..."

    # Check for common backend directory structures
    if [[ -d "backend" ]]; then
        BACKEND_PATH="backend"
        HAS_BACKEND=true
        debug_print "Found backend directory"
    elif [[ -d "api" ]]; then
        BACKEND_PATH="api"
        HAS_BACKEND=true
        debug_print "Found api directory"
    elif [[ -d "server" ]]; then
        BACKEND_PATH="server"
        HAS_BACKEND=true
        debug_print "Found server directory"
    elif [[ -f "requirements.txt" || -f "pyproject.toml" || -f "main.py" ]]; then
        BACKEND_PATH="."
        HAS_BACKEND=true
        debug_print "Found backend in root directory"
    fi

    # Check for Python
    if contains_files "*.py" "$BACKEND_PATH"; then
        HAS_PYTHON=true
        debug_print "Python detected"
    fi

    # Check for FastAPI
    local requirements_path="$BACKEND_PATH/requirements.txt"
    if [[ "$BACKEND_PATH" == "." ]]; then
        requirements_path="requirements.txt"
    fi

    if has_python_dependency "fastapi" "$requirements_path"; then
        HAS_FASTAPI=true
        debug_print "FastAPI detected"
    fi
}

# Detect testing frameworks and test files
detect_tests() {
    debug_print "Detecting tests..."

    # Check for test directories and files
    if [[ -d "tests" ]] || [[ -d "test" ]] || \
       contains_files "*test*.py" "." || \
       contains_files "*test*.js" "." || \
       contains_files "*test*.ts" "." || \
       contains_files "*.test.*" "." || \
       contains_files "*.spec.*" "."; then
        HAS_TESTS=true
        debug_print "Tests detected"
    fi
}

# Determine overall project type based on detected components
determine_project_type() {
    debug_print "Determining project type..."

    if [[ "$HAS_FRONTEND" == true && "$HAS_BACKEND" == true ]]; then
        PROJECT_TYPE="fullstack"
    elif [[ "$HAS_FRONTEND" == true ]]; then
        if [[ "$HAS_TYPESCRIPT" == true ]]; then
            PROJECT_TYPE="frontend-typescript"
        else
            PROJECT_TYPE="frontend-javascript"
        fi
    elif [[ "$HAS_BACKEND" == true ]]; then
        if [[ "$HAS_PYTHON" == true ]]; then
            PROJECT_TYPE="backend-python"
        else
            PROJECT_TYPE="backend-generic"
        fi
    elif [[ "$HAS_TYPESCRIPT" == true ]]; then
        PROJECT_TYPE="typescript"
    elif [[ "$HAS_JAVASCRIPT" == true ]]; then
        PROJECT_TYPE="javascript"
    elif [[ "$HAS_PYTHON" == true ]]; then
        PROJECT_TYPE="python"
    else
        PROJECT_TYPE="generic"
    fi

    debug_print "Project type determined: $PROJECT_TYPE"
}

# Generate configuration object
generate_config() {
    cat << EOF
{
  "project": {
    "type": "$PROJECT_TYPE",
    "has_frontend": $HAS_FRONTEND,
    "has_backend": $HAS_BACKEND,
    "has_typescript": $HAS_TYPESCRIPT,
    "has_javascript": $HAS_JAVASCRIPT,
    "has_python": $HAS_PYTHON,
    "has_react": $HAS_REACT,
    "has_fastapi": $HAS_FASTAPI,
    "has_tests": $HAS_TESTS,
    "frontend_path": "$FRONTEND_PATH",
    "backend_path": "$BACKEND_PATH"
  },
  "languages": [$(
    languages=()
    [[ "$HAS_TYPESCRIPT" == true ]] && languages+=("\"typescript\"")
    [[ "$HAS_JAVASCRIPT" == true ]] && languages+=("\"javascript\"")
    [[ "$HAS_PYTHON" == true ]] && languages+=("\"python\"")
    IFS=','; echo "${languages[*]}"
  )],
  "frameworks": [$(
    frameworks=()
    [[ "$HAS_REACT" == true ]] && frameworks+=("\"react\"")
    [[ "$HAS_FASTAPI" == true ]] && frameworks+=("\"fastapi\"")
    IFS=','; echo "${frameworks[*]}"
  )]
}
EOF
}

# Main detection function
detect_project() {
    echo -e "${BLUE}🔍 Detecting project structure...${NC}"

    detect_frontend
    detect_backend
    detect_tests
    determine_project_type

    echo -e "${GREEN}✅ Project detection complete${NC}"
    echo -e "${YELLOW}Project Type:${NC} $PROJECT_TYPE"

    if [[ "$HAS_FRONTEND" == true ]]; then
        echo -e "${YELLOW}Frontend:${NC} $FRONTEND_PATH ($(
            tech=()
            [[ "$HAS_TYPESCRIPT" == true ]] && tech+=("TypeScript")
            [[ "$HAS_JAVASCRIPT" == true ]] && tech+=("JavaScript")
            [[ "$HAS_REACT" == true ]] && tech+=("React")
            IFS=', '; echo "${tech[*]}"
        ))"
    fi

    if [[ "$HAS_BACKEND" == true ]]; then
        echo -e "${YELLOW}Backend:${NC} $BACKEND_PATH ($(
            tech=()
            [[ "$HAS_PYTHON" == true ]] && tech+=("Python")
            [[ "$HAS_FASTAPI" == true ]] && tech+=("FastAPI")
            IFS=', '; echo "${tech[*]}"
        ))"
    fi

    [[ "$HAS_TESTS" == true ]] && echo -e "${YELLOW}Tests:${NC} Detected"
}

# Command-line interface
case "${1:-detect}" in
    "detect")
        detect_project
        ;;
    "json")
        detect_frontend
        detect_backend
        detect_tests
        determine_project_type
        generate_config
        ;;
    "type")
        detect_frontend
        detect_backend
        detect_tests
        determine_project_type
        echo "$PROJECT_TYPE"
        ;;
    "help")
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  detect    Show detailed project detection (default)"
        echo "  json      Output detection results as JSON"
        echo "  type      Output only the project type"
        echo "  help      Show this help message"
        echo ""
        echo "Environment variables:"
        echo "  DEBUG=true    Enable debug output"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
