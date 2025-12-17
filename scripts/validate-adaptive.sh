#!/bin/bash

# Universal Adaptive Validation Script
# Runs quality checks based on project configuration and detected structure

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Global configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(pwd)"
CONFIG_FILE=".quality-config.yaml"
BASELINE_FILE=".quality-baseline.json"
VALIDATION_RESULTS=()
OVERALL_SUCCESS=true
CURRENT_PHASE=0
CHANGED_FILES_ONLY=false

# Function to print formatted messages
print_header() {
    echo ""
    echo -e "${BOLD}${BLUE}═══ $1 ═══${NC}"
}

print_section() {
    echo -e "\n${CYAN}▶ $1${NC}"
}

print_status() {
    echo -e "${BLUE}  ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}  ✅${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}  ⚠${NC} $1"
}

print_error() {
    echo -e "${RED}  ❌${NC} $1"
}

print_skip() {
    echo -e "${YELLOW}  ⏭${NC} $1"
}

# Function to read configuration values
read_config() {
    local key="$1"
    local default_value="${2:-false}"

    if [[ -f "$CONFIG_FILE" ]] && command -v yq >/dev/null 2>&1; then
        yq eval ".$key" "$CONFIG_FILE" 2>/dev/null || echo "$default_value"
    elif [[ -f "$CONFIG_FILE" ]] && command -v python3 >/dev/null 2>&1; then
        python3 -c "
import yaml, sys
try:
    with open('$CONFIG_FILE', 'r') as f:
        config = yaml.safe_load(f)
    keys = '$key'.split('.')
    value = config
    for k in keys:
        value = value.get(k, {})
    # Convert Python booleans to lowercase strings for bash compatibility
    if isinstance(value, bool):
        value = str(value).lower()
    print(value if value != {} else '$default_value')
except:
    print('$default_value')
" 2>/dev/null
    else
        echo "$default_value"
    fi
}

# Function to check if a tool is enabled
is_tool_enabled() {
    local tool_path="$1"
    local enabled=$(read_config "$tool_path")

    case "$enabled" in
        "true"|"auto")
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

# Function to check if a tool should enforce in the current phase
should_enforce_tool() {
    local tool_path="$1"
    local current_phase="$CURRENT_PHASE"

    # Check if tool is enabled first
    local enabled=$(is_tool_enabled "$tool_path")
    if [[ "$enabled" != "true" ]]; then
        echo "disabled"
        return
    fi

    # Check phase-specific enforcement
    local phase_enforce=$(read_config "${tool_path}.phase_${current_phase}_enforce")
    if [[ "$phase_enforce" == "true" ]]; then
        echo "enforce"
    elif [[ "$phase_enforce" == "false" ]]; then
        echo "warning"
    else
        # Default: enforce if enabled
        echo "enforce"
    fi
}

# Function to record validation result
record_result() {
    local tool="$1"
    local status="$2"
    local message="$3"

    VALIDATION_RESULTS+=("$tool:$status:$message")
    if [[ "$status" == "FAILED" ]]; then
        OVERALL_SUCCESS=false
    fi
}

# Function to initialize phase configuration
initialize_phase_config() {
    CURRENT_PHASE=$(read_config "quality_gates.current_phase" "0")

    # Phase 1-2 can use changed-files-only mode
    # Phase 3 MUST do full repository validation (no bypasses)
    if (( CURRENT_PHASE >= 1 && CURRENT_PHASE < 3 )); then
        local changed_files_enabled=$(read_config "quality_gates.phases.phase_1.changed_files_only" "false")
        [[ "$changed_files_enabled" == "true" ]] && CHANGED_FILES_ONLY=true
    fi

    print_status "Quality Gate Phase: $CURRENT_PHASE"
    if [[ "$CHANGED_FILES_ONLY" == "true" ]]; then
        print_status "Mode: Changed files only"
    else
        print_status "Mode: Full repository validation"
    fi
}

# Function to get changed files (for Phase 1+ enforcement)
get_changed_files() {
    local file_pattern="$1"

    if [[ "$CHANGED_FILES_ONLY" != "true" ]]; then
        echo ""
        return 0
    fi

    # Get changed files from git
    local changed_files=""
    if git rev-parse --git-dir >/dev/null 2>&1; then
        # Get staged and unstaged changes
        changed_files=$(git diff --name-only HEAD 2>/dev/null || echo "")
        local staged_files=$(git diff --cached --name-only 2>/dev/null || echo "")

        # Combine and filter by pattern
        local all_files=$(echo -e "$changed_files\n$staged_files" | sort -u | grep -E "$file_pattern" || echo "")
        echo "$all_files"
    else
        # Not a git repository - check all files
        echo ""
    fi
}

# Function to check if validation should run based on phase and changed files
should_run_validation() {
    local tool_name="$1"
    local file_pattern="$2"

    # Always run in Phase 0 (baseline mode)
    if (( CURRENT_PHASE == 0 )); then
        return 0
    fi

    # In Phase 1+, check if we have changed files for this tool
    if [[ "$CHANGED_FILES_ONLY" == "true" ]]; then
        local changed_files=$(get_changed_files "$file_pattern")
        if [[ -z "$changed_files" ]]; then
            print_skip "$tool_name validation (no changed files)"
            return 1
        else
            print_status "$tool_name validation ($(echo "$changed_files" | wc -l | tr -d ' ') changed files)"
        fi
    fi

    return 0
}

# Function to run phase-aware validation
run_phase_validation() {
    local description="$1"
    local command="$2"
    local tool_name="$3"
    local fix_command="${4:-}"
    local file_pattern="${5:-.*}"

    # Check if validation should run for this phase
    if ! should_run_validation "$tool_name" "$file_pattern"; then
        record_result "$tool_name" "SKIPPED" "$description (changed files only)"
        return 0
    fi

    print_status "Running $description..."

    # Phase 0: Baseline mode - check against baseline if available
    if (( CURRENT_PHASE == 0 )) && [[ -f "$BASELINE_FILE" ]]; then
        # Run normal validation but provide context about baseline
        if eval "$command" >/dev/null 2>&1; then
            print_success "$description - PASSED (Phase $CURRENT_PHASE: baseline maintained)"
            record_result "$tool_name" "PASSED" "$description"
            return 0
        else
            print_error "$description - FAILED (Phase $CURRENT_PHASE: regression from baseline)"
            [[ -n "$fix_command" ]] && print_status "Fix with: $fix_command"
            record_result "$tool_name" "FAILED" "$description"
            return 1
        fi
    # Phase 1+: Normal validation with phase context
    else
        if eval "$command" >/dev/null 2>&1; then
            print_success "$description - PASSED (Phase $CURRENT_PHASE)"
            record_result "$tool_name" "PASSED" "$description"
            return 0
        else
            print_error "$description - FAILED (Phase $CURRENT_PHASE: strict enforcement)"
            [[ -n "$fix_command" ]] && print_status "Fix with: $fix_command"
            record_result "$tool_name" "FAILED" "$description"
            return 1
        fi
    fi
}

# Function to show phase-specific guidance
show_phase_guidance() {
    local phase="$CURRENT_PHASE"

    echo ""
    echo -e "${BOLD}Phase $phase Guidance:${NC}"

    case "$phase" in
        "0")
            echo -e "${BLUE}📊 Baseline & Stabilization${NC}"
            echo -e "  • Focus: Prevent regressions from current baseline"
            echo -e "  • Strategy: Fix any new issues, legacy issues documented"
            echo -e "  • Next: Run './scripts/quality-gate-manager.sh advance' when stable"
            ;;
        "1")
            echo -e "${BLUE}🎯 Changed-Code-Only Enforcement${NC}"
            echo -e "  • Focus: Strict quality for new/modified code only"
            echo -e "  • Strategy: Perfect new code, gradual legacy improvement"
            echo -e "  • Files checked: Only changed/staged files"
            ;;
        "2")
            echo -e "${BLUE}📈 Ratchet & Expand Scope${NC}"
            echo -e "  • Focus: Progressive improvement across entire codebase"
            echo -e "  • Strategy: Coverage ratchet, module-by-module campaigns"
            echo -e "  • Enforcement: Repository-wide quality standards"
            ;;
        "3")
            echo -e "${BLUE}🔒 Normalize & Harden${NC}"
            echo -e "  • Focus: Full strict enforcement, no compromises"
            echo -e "  • Strategy: Zero technical debt, production-ready quality"
            echo -e "  • Enforcement: All quality gates blocking, no bypasses"
            ;;
    esac
}

# Function to run a command with nice output formatting
run_validation() {
    local description="$1"
    local command="$2"
    local tool_name="$3"
    local fix_command="${4:-}"

    print_status "Running $description..."

    if eval "$command" >/dev/null 2>&1; then
        print_success "$description - PASSED"
        record_result "$tool_name" "PASSED" "$description"
        return 0
    else
        print_error "$description - FAILED"
        [[ -n "$fix_command" ]] && print_status "Fix with: $fix_command"
        record_result "$tool_name" "FAILED" "$description"
        return 1
    fi
}

# Function to validate frontend
validate_frontend() {
    local frontend_enabled=$(is_tool_enabled "tools.frontend.enabled")
    local frontend_path=$(read_config "project.structure.frontend_path" "frontend")

    if [[ "$frontend_enabled" != "true" ]]; then
        print_skip "Frontend validation disabled"
        return 0
    fi

    if [[ ! -d "$frontend_path" && "$frontend_path" != "." ]]; then
        print_skip "Frontend directory not found: $frontend_path"
        return 0
    fi

    print_section "Frontend Validation"

    # Change to frontend directory if needed
    local original_dir="$PWD"
    if [[ "$frontend_path" != "." ]]; then
        cd "$frontend_path" || return 1
    fi

    local frontend_failed=false

    # Check if dependencies are installed
    if [[ -f "package.json" ]]; then
        if [[ ! -d "node_modules" ]]; then
            print_status "Installing frontend dependencies..."
            if ! npm ci --silent; then
                print_error "Failed to install frontend dependencies"
                frontend_failed=true
            fi
        fi
    fi

    # ESLint validation
    local eslint_enabled=$(read_config "tools.frontend.eslint.enabled")
    if [[ "$eslint_enabled" == "true" || "$eslint_enabled" == "auto" ]]; then
        if [[ -f "package.json" ]] && npm list eslint >/dev/null 2>&1; then
            run_phase_validation "ESLint check" "npm run lint" "eslint" "npm run lint:fix" "\.(js|jsx|ts|tsx)$" || frontend_failed=true
        else
            print_skip "ESLint not available"
        fi
    fi

    # TypeScript validation
    local typescript_enabled=$(read_config "tools.frontend.typescript.enabled")
    if [[ "$typescript_enabled" == "true" ]]; then
        if [[ -f "tsconfig.json" ]] || contains_files "*.ts" "src"; then
            run_phase_validation "TypeScript check" "npx tsc --noEmit" "typescript" "npx tsc --noEmit --pretty" "\.(ts|tsx)$" || frontend_failed=true
        else
            print_skip "TypeScript not configured"
        fi
    fi

    # Frontend tests
    local testing_enabled=$(read_config "tools.frontend.testing.unit_tests")
    if [[ "$testing_enabled" == "true" ]]; then
        if [[ -f "package.json" ]] && (npm list jest >/dev/null 2>&1 || npm list vitest >/dev/null 2>&1); then
            # Detect test framework and use appropriate flags
            local has_jest=$(npm list jest >/dev/null 2>&1 && echo "true" || echo "false")
            local has_vitest=$(npm list vitest >/dev/null 2>&1 && echo "true" || echo "false")

            if [[ "$has_jest" == "true" && "$has_vitest" == "true" ]]; then
                # Both frameworks present - prefer Vitest if both installed
                print_status "Both Jest and Vitest detected, using Vitest"
                run_validation "Frontend tests" "npm test -- --run --passWithNoTests" "frontend-tests" "npm test -- --run" || frontend_failed=true
            elif [[ "$has_jest" == "true" ]]; then
                # Jest uses --watchAll=false for non-interactive mode
                run_validation "Frontend tests (Jest)" "npm test -- --watchAll=false --passWithNoTests" "frontend-tests" "npm test" || frontend_failed=true
            elif [[ "$has_vitest" == "true" ]]; then
                # Vitest uses --run for non-interactive mode
                run_validation "Frontend tests (Vitest)" "npm test -- --run --passWithNoTests" "frontend-tests" "npm test -- --run" || frontend_failed=true
            else
                # Fallback: try without framework-specific flags
                print_status "Unknown test framework, attempting npm test without special flags"
                run_validation "Frontend tests" "npm test -- --passWithNoTests" "frontend-tests" "npm test" || frontend_failed=true
            fi
        else
            print_skip "Frontend tests not configured"
        fi
    fi

    # Build check
    if [[ -f "package.json" ]] && npm run build --dry-run >/dev/null 2>&1; then
        if ! run_validation "Frontend build" "npm run build" "frontend-build" "npm run lint:fix && npm run build"; then
            frontend_failed=true
            print_status "💡 Build failed. Try these steps:"
            print_status "   1. 🔧 Fix linting issues: npm run lint:fix"
            print_status "   2. 🏗️ Retry build: npm run build"
            print_status "   3. 📝 Check build output above for specific errors"
        fi
    fi

    cd "$original_dir"
    return $([ "$frontend_failed" == "false" ] && echo 0 || echo 1)
}

# Function to validate backend
validate_backend() {
    local backend_enabled=$(is_tool_enabled "tools.backend.enabled")
    local backend_path=$(read_config "project.structure.backend_path" "backend")

    if [[ "$backend_enabled" != "true" ]]; then
        print_skip "Backend validation disabled"
        return 0
    fi

    if [[ ! -d "$backend_path" && "$backend_path" != "." ]]; then
        print_skip "Backend directory not found: $backend_path"
        return 0
    fi

    print_section "Backend Validation"

    # Change to backend directory if needed
    local original_dir="$PWD"
    if [[ "$backend_path" != "." ]]; then
        cd "$backend_path" || return 1
    fi

    local backend_failed=false

    # Python validation
    local python_enabled=$(read_config "tools.backend.python.enabled")
    if [[ "$python_enabled" == "true" ]]; then
        # Run individual Python quality checks
        cd "$backend_path" || return 1

        # Black formatting check
        local black_enabled=$(read_config "tools.backend.python.black.enabled")
        if [[ "$black_enabled" == "true" ]] && command -v black >/dev/null 2>&1; then
            run_phase_validation "Black formatting" "black --check ." "black" "black ." "\.py$" || backend_failed=true
        fi

        # isort import sorting check
        local isort_enabled=$(read_config "tools.backend.python.isort.enabled")
        if [[ "$isort_enabled" == "true" ]] && command -v isort >/dev/null 2>&1; then
            run_phase_validation "Import sorting" "isort --check-only ." "isort" "isort ." "\.py$" || backend_failed=true
        fi

        # flake8 linting check
        local flake8_enabled=$(read_config "tools.backend.python.flake8.enabled")
        if [[ "$flake8_enabled" == "true" ]] && command -v flake8 >/dev/null 2>&1; then
            run_phase_validation "Flake8 linting" "flake8 ." "flake8" "flake8 . --show-source" "\.py$" || backend_failed=true
        fi

        # MyPy type checking (phase-aware enforcement)
        local mypy_enforcement=$(should_enforce_tool "tools.backend.python.mypy")
        if [[ "$mypy_enforcement" != "disabled" ]] && command -v mypy >/dev/null 2>&1; then
            if [[ "$mypy_enforcement" == "warning" ]]; then
                # Run mypy but don't fail on errors in Phase 0
                print_status "Running MyPy type checking (warnings only, Phase $CURRENT_PHASE)..."
                if mypy . >/dev/null 2>&1; then
                    print_success "MyPy type checking - PASSED"
                    record_result "mypy" "PASSED" "MyPy type checking"
                else
                    print_warning "MyPy type checking - Issues found (not blocking in Phase $CURRENT_PHASE)"
                    print_status "Fix with: mypy . --show-error-codes"
                    record_result "mypy" "WARNING" "MyPy type checking (not enforced)"
                fi
            else
                # Enforce mypy errors in Phase 1+
                run_validation "MyPy type checking" "mypy ." "mypy" "mypy . --show-error-codes" || backend_failed=true
            fi
        fi

        # Backend tests
        local testing_enabled=$(read_config "tools.backend.testing.unit_tests")
        if [[ "$testing_enabled" == "true" ]] && command -v pytest >/dev/null 2>&1; then
            run_validation "Backend tests" "python -m pytest" "backend-tests" "python -m pytest -v" || backend_failed=true
        fi
    fi

    cd "$original_dir"
    return $([ "$backend_failed" == "false" ] && echo 0 || echo 1)
}

# Function to validate security
validate_security() {
    local security_enabled=$(is_tool_enabled "tools.security.enabled")

    if [[ "$security_enabled" != "true" ]]; then
        print_skip "Security validation disabled"
        return 0
    fi

    print_section "Security Validation"

    local security_failed=false

    # Secret detection
    local secret_detection=$(read_config "tools.security.secret_detection") # pragma: allowlist secret
    if [[ "$secret_detection" == "true" ]] && command -v detect-secrets >/dev/null 2>&1; then  # pragma: allowlist secret
        run_validation "Secret detection" "detect-secrets scan --baseline .secrets.baseline ." "secrets" "Review detected secrets" || security_failed=true  # pragma: allowlist secret
    fi

    # Dependency scanning for frontend
    local has_frontend=$(read_config "project.structure.has_frontend")
    if [[ "$has_frontend" == "true" && -f "package.json" ]]; then
        run_validation "Frontend dependency scan" "npm audit --audit-level=moderate" "npm-audit" "npm audit fix" || security_failed=true
    fi

    # Dependency scanning for backend
    local has_python=$(read_config "project.structure.has_python")
    if [[ "$has_python" == "true" ]]; then
        if command -v pip-audit >/dev/null 2>&1; then
            # Set up pip-audit to use the correct Python environment
            local pip_audit_cmd="pip-audit"
            local pip_audit_fix_cmd="pip-audit --desc"

            # Handle virtual environments to avoid unintuitive audits
            if [[ -n "$VIRTUAL_ENV" ]]; then
                # Already in activated virtual environment
                pip_audit_cmd="PIPAPI_PYTHON_LOCATION=\"$VIRTUAL_ENV/bin/python\" pip-audit"
                pip_audit_fix_cmd="PIPAPI_PYTHON_LOCATION=\"$VIRTUAL_ENV/bin/python\" pip-audit --desc"
            elif [[ -f ".venv/bin/python" ]]; then
                # Virtual environment exists but not activated
                local venv_python="$(pwd)/.venv/bin/python"
                pip_audit_cmd="PIPAPI_PYTHON_LOCATION=\"$venv_python\" pip-audit"
                pip_audit_fix_cmd="PIPAPI_PYTHON_LOCATION=\"$venv_python\" pip-audit --desc"
            elif [[ -f "venv/bin/python" ]]; then
                # Alternative venv name
                local venv_python="$(pwd)/venv/bin/python"
                pip_audit_cmd="PIPAPI_PYTHON_LOCATION=\"$venv_python\" pip-audit"
                pip_audit_fix_cmd="PIPAPI_PYTHON_LOCATION=\"$venv_python\" pip-audit --desc"
            fi

            run_validation "Python dependency scan" "$pip_audit_cmd" "pip-audit" "# 1. Review vulnerabilities:\n$pip_audit_fix_cmd\n# 2. Fix automatically (but review first!):\npip-audit --fix\n# 3. Update requirements:\npip freeze > requirements.txt" || security_failed=true
        elif command -v safety >/dev/null 2>&1; then
            # Fallback to safety (requires registration)
            run_validation "Python dependency scan" "safety scan" "safety" "safety scan --detailed-output && pip install --upgrade [vulnerable-packages]" || security_failed=true
        else
            print_warning "No Python dependency scanner available"
            print_status "Install pip-audit: pip install pip-audit"
        fi
    fi

    return $([ "$security_failed" == "false" ] && echo 0 || echo 1)
}

# Function to validate pre-commit hooks
validate_precommit() {
    print_section "Pre-commit Validation"

    local precommit_enabled=$(read_config "tools.quality.pre_commit_hooks")
    if [[ "$precommit_enabled" != "true" ]]; then
        print_skip "Pre-commit hooks disabled"
        return 0
    fi

    local precommit_failed=false

    # Check if pre-commit is installed
    if ! command -v pre-commit >/dev/null 2>&1; then
        print_error "pre-commit not installed"
        print_status "Install with: pip install pre-commit"
        record_result "pre-commit" "FAILED" "pre-commit not installed"
        return 1
    fi

    # Check if hooks are installed
    if [[ ! -f ".git/hooks/pre-commit" ]]; then
        print_warning "Pre-commit hooks not installed"
        print_status "Install with: pre-commit install"
        record_result "pre-commit" "FAILED" "hooks not installed"
        return 1
    fi

    # Run pre-commit validation
    if ! run_validation "Pre-commit hooks" "pre-commit run --all-files" "pre-commit" "pre-commit run --all-files"; then
        precommit_failed=true
        print_status "💡 Pre-commit hooks failed. Try these steps:"
        print_status "   1. 🔧 Run hooks in fix mode: pre-commit run --all-files"
        print_status "      (Many hooks like Black, isort, ESLint auto-fix issues)"
        print_status "   2. 📝 Check output above for specific tool failures"
        print_status "   3. 🔍 For manual fixes, use individual tool commands:"
        print_status "      • Python: black . && isort . && flake8 ."
        print_status "      • Frontend: npm run lint:fix"
        print_status "   4. ✅ Re-run validation: ./scripts/validate-adaptive.sh"
    fi

    return $([ "$precommit_failed" == "false" ] && echo 0 || echo 1)
}

# Function to check configuration and project structure
validate_configuration() {
    print_section "Configuration Validation"

    # Check if configuration file exists
    if [[ ! -f "$CONFIG_FILE" ]]; then
        print_error "Quality configuration not found: $CONFIG_FILE"
        print_status "Run: ./scripts/generate-config.sh to create configuration"
        record_result "config" "FAILED" "Missing configuration file"
        return 1
    fi

    print_success "Quality configuration found"

    # Show current configuration summary
    local project_type=$(read_config "project.type")
    local current_phase=$(read_config "quality_gates.current_phase" "0")

    print_status "Project type: $project_type"
    print_status "Quality gate phase: $current_phase"

    record_result "config" "PASSED" "Configuration valid"
    return 0
}

# Function to show validation summary
show_summary() {
    print_header "Validation Summary"

    local passed_count=0
    local failed_count=0
    local total_count=${#VALIDATION_RESULTS[@]}

    echo -e "${BOLD}Results by Tool:${NC}"
    for result in "${VALIDATION_RESULTS[@]}"; do
        IFS=':' read -r tool status message <<< "$result" || true
        case "$status" in
            "PASSED")
                echo -e "  ${GREEN}✅ $tool${NC}: $message"
                ((passed_count++)) || true
                ;;
            "FAILED")
                echo -e "  ${RED}❌ $tool${NC}: $message"
                ((failed_count++)) || true
                ;;
        esac
    done

    echo ""
    echo -e "${BOLD}Summary:${NC}"
    echo -e "  ${GREEN}Passed: $passed_count${NC}"
    echo -e "  ${RED}Failed: $failed_count${NC}"
    echo -e "  ${BLUE}Total: $total_count${NC}"

    if [[ "$OVERALL_SUCCESS" == "true" ]]; then
        echo ""
        echo -e "${GREEN}${BOLD}🎉 All validations passed!${NC}"
        echo -e "${BLUE}Your code meets the current quality standards.${NC}"
        return 0
    else
        echo ""
        echo -e "${RED}${BOLD}❌ Some validations failed.${NC}"
        echo -e "${YELLOW}Please fix the issues above before committing.${NC}"
        echo ""
        echo -e "${BLUE}Quick fixes:${NC}"
        echo -e "  ${YELLOW}Format code:${NC} npm run lint:fix && ./scripts/format-backend.sh"
        echo -e "  ${YELLOW}Run hooks:${NC} pre-commit run --all-files"
        echo -e "  ${YELLOW}Validate again:${NC} ./scripts/validate-adaptive.sh"
        return 1
    fi
}

# Function to help with missing tools
contains_files() {
    local pattern="$1"
    local path="${2:-.}"
    find "$path" -maxdepth 3 -name "$pattern" -type f 2>/dev/null | head -1 | grep -q .
}

# Main validation function
main() {
    print_header "Adaptive Quality Validation"

    # Check if we're in the right directory
    if [[ ! -f "package.json" && ! -f "pyproject.toml" && ! -f "requirements.txt" ]]; then
        print_error "Please run from project root directory"
        exit 1
    fi

    print_status "Starting validation for $(basename "$PROJECT_ROOT")"

    # Initialize phase configuration
    initialize_phase_config

    # Run all validations
    validate_configuration
    validate_precommit
    validate_frontend
    validate_backend
    validate_security

    # Show final summary
    show_summary
    exit_code=$?

    # Show phase-specific guidance
    show_phase_guidance

    echo ""
    print_status "For configuration options, see: $CONFIG_FILE"
    print_status "For phase management, use: $0 status|advance|set-phase"

    exit $exit_code
}

# Phase management functions
get_current_phase() {
    local phase=$(read_config "quality_gates.current_phase" "0")
    echo "$phase"
}

set_phase() {
    local new_phase="$1"

    if [[ ! "$new_phase" =~ ^[0-3]$ ]]; then
        print_error "Invalid phase: $new_phase. Must be 0, 1, 2, or 3"
        return 1
    fi

    if [[ -f "$CONFIG_FILE" ]] && command -v yq >/dev/null 2>&1; then
        # Create backup
        cp "$CONFIG_FILE" "${CONFIG_FILE}.backup"

        # Update phase
        yq eval ".quality_gates.current_phase = $new_phase" -i "$CONFIG_FILE"

        print_success "Advanced to Phase $new_phase"
        # Update the global phase variable and show guidance
        CURRENT_PHASE="$new_phase"
        show_phase_guidance
    else
        print_error "Cannot update configuration. Ensure yq is installed and $CONFIG_FILE exists"
        return 1
    fi
}

advance_phase() {
    local current_phase=$(get_current_phase)
    local next_phase=$((current_phase + 1))

    if [[ $next_phase -gt 3 ]]; then
        print_warning "Already at maximum phase (3). Cannot advance further."
        return 1
    fi

    print_status "Advancing from Phase $current_phase to Phase $next_phase..."
    set_phase "$next_phase"
}

show_phase_status() {
    local current_phase=$(get_current_phase)

    print_header "Quality Gate Phase Status"
    echo -e "${BOLD}Current Phase:${NC} $current_phase"
    echo ""

    # Update the global phase variable and show guidance
    CURRENT_PHASE="$current_phase"
    show_phase_guidance

    echo ""
    echo -e "${BOLD}Phase Management Commands:${NC}"
    echo -e "  ${CYAN}./scripts/validate-adaptive.sh advance${NC}     - Move to next phase"
    echo -e "  ${CYAN}./scripts/validate-adaptive.sh set-phase N${NC} - Set specific phase (0-3)"
    echo -e "  ${CYAN}./scripts/validate-adaptive.sh status${NC}      - Show current phase status"
}

# Command-line interface
case "${1:-validate}" in
    "validate"|"")
        main
        ;;
    "frontend")
        print_header "Frontend-Only Validation"
        validate_configuration
        validate_frontend
        show_summary
        ;;
    "backend")
        print_header "Backend-Only Validation"
        validate_configuration
        validate_backend
        show_summary
        ;;
    "security")
        print_header "Security-Only Validation"
        validate_configuration
        validate_security
        show_summary
        ;;
    "advance")
        advance_phase
        ;;
    "set-phase")
        if [[ -z "$2" ]]; then
            print_error "Phase number required. Usage: $0 set-phase N (where N is 0-3)"
            exit 1
        fi
        set_phase "$2"
        ;;
    "status")
        show_phase_status
        ;;
    "help")
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo ""
        echo "Validation:"
        echo "  validate      Run all validations (default)"
        echo "  frontend      Run only frontend validations"
        echo "  backend       Run only backend validations"
        echo "  security      Run only security validations"
        echo ""
        echo "Phase Management:"
        echo "  status        Show current quality gate phase"
        echo "  advance       Move to next phase (0→1→2→3)"
        echo "  set-phase N   Set specific phase (0-3)"
        echo ""
        echo "Other:"
        echo "  help          Show this help message"
        echo ""
        echo "Configuration:"
        echo "  Edit .quality-config.yaml to customize validation behavior"
        ;;
    *)
        print_error "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
