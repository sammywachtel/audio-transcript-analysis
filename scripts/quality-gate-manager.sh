#!/bin/bash

# Quality Gate Phase Management Script
# Manages graduated quality gate progression with automatic analysis and recommendations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
QUALITY_CONFIG_FILE=".quality-config.yaml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Helper functions
print_status() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

print_header() {
    echo ""
    print_status $BLUE "$1"
    echo "$(printf '=%.0s' {1..50})"
}

print_success() {
    print_status $GREEN "✅ $1"
}

print_error() {
    print_status $RED "❌ $1"
}

print_warning() {
    print_status $YELLOW "⚠️  $1"
}

print_info() {
    print_status $CYAN "ℹ️  $1"
}

# Get current phase from configuration
get_current_phase() {
    if [[ ! -f "$QUALITY_CONFIG_FILE" ]]; then
        echo "0"  # Default to baseline phase
        return
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import yaml
try:
    with open('$QUALITY_CONFIG_FILE', 'r') as f:
        config = yaml.safe_load(f) or {}
    print(config.get('quality_gates', {}).get('current_phase', 0))
except:
    print(0)
" 2>/dev/null || echo "0"
    else
        # Fallback to basic parsing if Python not available
        grep "current_phase:" "$QUALITY_CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*: *//' || echo "0"
    fi
}

# Show current phase status and metrics
show_phase_status() {
    local current_phase=$(get_current_phase)

    print_header "🎯 Quality Gate Phase Status"

    echo ""
    print_status $CYAN "Current Phase: $current_phase"

    case "$current_phase" in
        "0")
            print_status $BLUE "Phase 0: Baseline & Stabilization"
            echo "  • Goal: Prevent regressions from documented baseline"
            echo "  • Enforcement: No regressions allowed, legacy issues documented"
            echo "  • Duration: 1-3 days (immediate setup)"
            ;;
        "1")
            print_status $BLUE "Phase 1: Changed-Code-Only Enforcement"
            echo "  • Goal: Perfect new code, gradual legacy improvement"
            echo "  • Enforcement: Strict quality for modified files only"
            echo "  • Duration: 1-2 weeks (depends on development velocity)"
            ;;
        "2")
            print_status $BLUE "Phase 2: Repository-Wide + Ratcheting"
            echo "  • Goal: Systematic improvement across entire codebase"
            echo "  • Enforcement: Repository-wide for most tools, coverage ratcheting"
            echo "  • Duration: 2-4 weeks (depends on tech debt)"
            ;;
        "3")
            print_status $BLUE "Phase 3: Full Strict Enforcement"
            echo "  • Goal: Production-ready standards, zero tolerance"
            echo "  • Enforcement: All quality gates blocking, branch protection active"
            echo "  • Duration: Ongoing maintenance"
            ;;
    esac

    echo ""
    print_status $CYAN "Available Commands:"
    echo "  • quality-gate-manager.sh advance    → Move to next phase"
    echo "  • quality-gate-manager.sh set-phase N → Jump to specific phase"
    echo "  • quality-gate-manager.sh baseline   → Establish quality baseline"
    echo "  • quality-gate-manager.sh check      → Check current phase requirements"

    # Show next phase info if not at max
    if [[ $current_phase -lt 3 ]]; then
        local next_phase=$((current_phase + 1))
        echo ""
        print_status $YELLOW "Next Phase ($next_phase):"
        case "$next_phase" in
            "1") echo "  → Changed-files-only enforcement (perfect new code)" ;;
            "2") echo "  → Repository-wide enforcement with ratcheting" ;;
            "3") echo "  → Full strict enforcement (production ready)" ;;
        esac
        print_info "Run 'quality-gate-manager.sh advance' to progress"
    else
        echo ""
        print_success "🎉 You're at the highest phase! All quality gates are fully active."
    fi
}

# Update phase in configuration file
update_phase_config() {
    local new_phase=$1
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [[ ! -f "$QUALITY_CONFIG_FILE" ]]; then
        print_error "Quality configuration file not found: $QUALITY_CONFIG_FILE"
        return 1
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import yaml
try:
    with open('$QUALITY_CONFIG_FILE', 'r') as f:
        config = yaml.safe_load(f) or {}

    # Update phase configuration
    if 'quality_gates' not in config:
        config['quality_gates'] = {}

    config['quality_gates']['current_phase'] = $new_phase
    config['quality_gates']['last_updated'] = '$timestamp'

    # Add phase transition log
    if 'phase_history' not in config:
        config['phase_history'] = []

    config['phase_history'].append({
        'phase': $new_phase,
        'timestamp': '$timestamp',
        'method': 'quality-gate-manager'
    })

    with open('$QUALITY_CONFIG_FILE', 'w') as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)

    print('Updated phase to $new_phase')
except Exception as e:
    print(f'Error updating config: {e}', file=sys.stderr)
    exit(1)
"
    else
        print_error "Python 3 with PyYAML is required for configuration management"
        return 1
    fi
}

# Advanced project analysis for sophisticated phase recommendation
analyze_project_for_phase() {
    print_header "🔍 Comprehensive Project Analysis for Phase Recommendation"

    # Initialize metrics
    local total_files=0
    local python_files=0
    local ts_files=0
    local js_files=0
    local lint_errors=0
    local ts_errors=0
    local test_files=0
    local has_types=false
    local has_comprehensive_tests=false
    local has_ci_cd=false
    local has_pre_commit=false
    local typing_coverage=0
    local estimated_dev_hours=0

    echo ""
    print_info "📊 Codebase Structure Analysis:"

    # Comprehensive file counting
    python_files=$(find . -name "*.py" -not -path "./node_modules/*" -not -path "./.venv/*" -not -path "./__pycache__/*" -not -path "./venv/*" 2>/dev/null | wc -l | tr -d ' ')
    ts_files=$(find . -name "*.ts" -o -name "*.tsx" -not -path "./node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
    js_files=$(find . -name "*.js" -o -name "*.jsx" -not -path "./node_modules/*" -not -path "./dist/*" 2>/dev/null | wc -l | tr -d ' ')
    total_files=$((python_files + ts_files + js_files))

    echo "  • Python files: $python_files"
    echo "  • TypeScript files: $ts_files"
    echo "  • JavaScript files: $js_files"
    echo "  • Total code files: $total_files"

    # Determine project type and complexity
    local project_type="unknown"
    local complexity="low"

    if [[ $python_files -gt 0 && $ts_files -gt 0 ]]; then
        project_type="fullstack"
    elif [[ $python_files -gt 0 ]]; then
        project_type="python"
    elif [[ $ts_files -gt 0 || $js_files -gt 0 ]]; then
        project_type="frontend"
    fi

    if [[ $total_files -gt 100 ]]; then
        complexity="high"
    elif [[ $total_files -gt 30 ]]; then
        complexity="medium"
    fi

    echo "  • Project type: $project_type ($complexity complexity)"
    echo ""

    print_info "🔧 Quality Infrastructure Analysis:"

    # Check for existing quality infrastructure
    if [[ -f ".pre-commit-config.yaml" ]]; then
        has_pre_commit=true
        echo "  ✅ Pre-commit hooks configured"
    else
        echo "  ❌ Pre-commit hooks not configured"
    fi

    if [[ -f ".github/workflows" ]] || [[ -d ".github/workflows" ]]; then
        has_ci_cd=true
        echo "  ✅ CI/CD workflows detected"
    else
        echo "  ❌ No CI/CD workflows found"
    fi

    if [[ -f "pyproject.toml" ]] || [[ -f "setup.cfg" ]] || [[ -f ".flake8" ]]; then
        echo "  ✅ Python quality tools configured"
    elif [[ $python_files -gt 0 ]]; then
        echo "  ⚠️  Python quality tools not configured"
    fi

    if [[ -f "eslint.config.js" ]] || [[ -f ".eslintrc.js" ]] || [[ -f ".eslintrc.json" ]]; then
        echo "  ✅ ESLint configured"
    elif [[ $ts_files -gt 0 || $js_files -gt 0 ]]; then
        echo "  ⚠️  ESLint not configured"
    fi

    echo ""
    print_info "🧪 Testing Infrastructure Analysis:"

    # Comprehensive test analysis
    test_files=$(find . -name "*test*.py" -o -name "*test*.ts" -o -name "*test*.tsx" -o -name "*test*.js" -o -name "*test*.jsx" -o -name "*.spec.*" -not -path "./node_modules/*" 2>/dev/null | wc -l | tr -d ' ')

    local test_dirs=0
    [[ -d "tests" ]] && test_dirs=$((test_dirs + 1)) && echo "  ✅ Main tests/ directory found"
    [[ -d "test" ]] && test_dirs=$((test_dirs + 1)) && echo "  ✅ Main test/ directory found"
    [[ -d "frontend/src/__tests__" ]] && test_dirs=$((test_dirs + 1)) && echo "  ✅ Frontend tests found"
    [[ -d "backend/tests" ]] && test_dirs=$((test_dirs + 1)) && echo "  ✅ Backend tests found"

    if [[ $test_files -gt 0 ]]; then
        echo "  • Test files found: $test_files"
        local test_coverage_ratio=$((test_files * 100 / (total_files + 1)))  # +1 to avoid divide by zero
        echo "  • Test coverage ratio: ${test_coverage_ratio}% (test files vs total files)"

        if [[ $test_dirs -ge 2 && $test_coverage_ratio -ge 20 ]]; then
            has_comprehensive_tests=true
            echo "  ✅ Comprehensive testing infrastructure"
        elif [[ $test_files -ge 5 ]]; then
            echo "  ⚠️  Basic testing infrastructure"
        else
            echo "  ❌ Minimal testing infrastructure"
        fi
    else
        echo "  ❌ No test files found"
    fi

    echo ""
    print_info "🔍 Code Quality Analysis:"

    # Python quality analysis
    if [[ $python_files -gt 0 ]]; then
        if command -v flake8 >/dev/null 2>&1; then
            local flake8_errors=$(flake8 . 2>/dev/null | wc -l | tr -d ' ')
            lint_errors=$((lint_errors + flake8_errors))
            echo "  • Python (flake8) issues: $flake8_errors"
        else
            echo "  ⚠️  flake8 not available for Python analysis"
        fi

        # Type hints analysis for Python
        local typed_py_files=$(find . -name "*.py" -not -path "./node_modules/*" -not -path "./.venv/*" -exec grep -l ":" {} \; 2>/dev/null | wc -l | tr -d ' ')
        if [[ $python_files -gt 0 ]]; then
            typing_coverage=$((typed_py_files * 100 / python_files))
            echo "  • Python typing coverage: ${typing_coverage}% ($typed_py_files/$python_files files)"
            if [[ $typing_coverage -ge 50 ]]; then
                has_types=true
            fi
        fi
    fi

    # TypeScript quality analysis
    if [[ $ts_files -gt 0 ]]; then
        if command -v tsc >/dev/null 2>&1 && [[ -f "tsconfig.json" || -f "frontend/tsconfig.json" ]]; then
            if [[ -f "frontend/tsconfig.json" ]]; then
                ts_errors=$(cd frontend && tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            else
                ts_errors=$(tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            fi
            lint_errors=$((lint_errors + ts_errors))
            echo "  • TypeScript compilation errors: $ts_errors"
            if [[ $ts_errors -eq 0 ]]; then
                has_types=true  # TypeScript implies typing
            fi
        else
            echo "  ⚠️  TypeScript compiler not available or not configured"
        fi
    fi

    # ESLint analysis
    if [[ $js_files -gt 0 || $ts_files -gt 0 ]]; then
        if command -v npx >/dev/null 2>&1 && [[ -f "package.json" ]]; then
            local eslint_errors=$(npx eslint . 2>/dev/null | grep -c "error" || echo "0")
            lint_errors=$((lint_errors + eslint_errors))
            echo "  • ESLint errors: $eslint_errors"
        else
            echo "  ⚠️  ESLint not available for JavaScript/TypeScript analysis"
        fi
    fi

    echo "  • Total quality issues: $lint_errors"

    echo ""
    print_info "📈 Development Velocity Estimation:"

    # Estimate effort required to reach different phases
    local phase_0_hours=1
    local phase_1_hours=$((2 + lint_errors / 10))
    local phase_2_hours=$((phase_1_hours + total_files / 10 + 8))
    local phase_3_hours=$((phase_2_hours + 16))

    if [[ ! $has_comprehensive_tests ]]; then
        phase_2_hours=$((phase_2_hours + 8))
        phase_3_hours=$((phase_3_hours + 16))
    fi

    echo "  • Estimated effort to Phase 1: ${phase_1_hours} hours"
    echo "  • Estimated effort to Phase 2: ${phase_2_hours} hours"
    echo "  • Estimated effort to Phase 3: ${phase_3_hours} hours"

    echo ""
    print_header "🎯 Phase Recommendation Analysis"

    # Sophisticated phase determination logic
    local recommended_phase=0
    local confidence="medium"
    local reasoning=""

    if [[ $total_files -lt 5 ]]; then
        recommended_phase=3
        confidence="high"
        reasoning="Very small/new project - start with strict enforcement from day one"
    elif [[ $total_files -lt 15 && $lint_errors -eq 0 ]]; then
        recommended_phase=3
        confidence="high"
        reasoning="Small, clean project - ready for strict enforcement"
    elif [[ $lint_errors -eq 0 && $has_types == true && $has_comprehensive_tests == true ]]; then
        recommended_phase=3
        confidence="high"
        reasoning="High-quality codebase with comprehensive testing and typing"
    elif [[ $lint_errors -lt 5 && $has_comprehensive_tests == true && $typing_coverage -ge 70 ]]; then
        recommended_phase=2
        confidence="high"
        reasoning="Good quality with strong test coverage and typing"
    elif [[ $lint_errors -lt 20 && $has_types == true ]]; then
        recommended_phase=2
        confidence="medium"
        reasoning="Decent quality with some typing - suitable for gradual improvement"
    elif [[ $lint_errors -lt 50 && $complexity != "high" ]]; then
        recommended_phase=1
        confidence="medium"
        reasoning="Moderate issues - focus on new code quality first"
    elif [[ $complexity == "high" && $lint_errors -gt 50 ]]; then
        recommended_phase=0
        confidence="high"
        reasoning="Large codebase with significant tech debt - start with baseline stabilization"
    else
        recommended_phase=0
        confidence="medium"
        reasoning="Significant quality debt - establish baseline and prevent regressions"
    fi

    # Display recommendation
    local phase_names=("Baseline & Stabilization" "Changed-Code-Only Enforcement" "Repository-Wide + Ratcheting" "Full Strict Enforcement")
    echo ""
    print_success "📋 RECOMMENDATION: Start at Phase $recommended_phase (${phase_names[$recommended_phase]})"
    echo "  • Confidence: $confidence"
    echo "  • Reasoning: $reasoning"
    echo ""

    # Show alternative phases
    print_info "🔄 Alternative Starting Points:"
    case "$recommended_phase" in
        "0")
            echo "  • Phase 1: Consider if team can handle quality debt in changed files ($phase_1_hours hours)"
            echo "  • Phase 2: Only if confident in team's quality discipline ($phase_2_hours hours)"
            ;;
        "1")
            echo "  • Phase 0: If team needs time to adapt to quality processes ($phase_0_hours hours)"
            echo "  • Phase 2: If team is experienced with quality gates ($phase_2_hours hours)"
            ;;
        "2")
            echo "  • Phase 1: If repository-wide enforcement seems too aggressive ($phase_1_hours hours)"
            echo "  • Phase 3: If codebase is exceptionally clean ($phase_3_hours hours)"
            ;;
        "3")
            echo "  • Phase 2: If you prefer gradual ramp-up ($phase_2_hours hours)"
            echo "  • Phase 1: Conservative approach for team adjustment ($phase_1_hours hours)"
            ;;
    esac

    echo ""
    print_info "💡 Next Steps:"
    echo "  1. Review the analysis above and decide on starting phase"
    echo "  2. Use './scripts/quality-gate-manager.sh set-phase <0-3>' to set your choice"
    echo "  3. Run './scripts/quality-gate-manager.sh check' to validate the setup"
    echo "  4. Begin development with the chosen quality enforcement level"

    echo $recommended_phase
}

# Advanced readiness assessment for phase progression
check_readiness_for_phase() {
    local target_phase=$1
    local current_phase=$(get_current_phase)

    print_info "📊 Readiness Assessment for Phase $target_phase:"
    echo ""

    local ready=true
    local warnings_count=0
    local blockers_count=0

    # Run project analysis to get current quality metrics
    local total_files=$(find . -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v .venv | grep -v __pycache__ | wc -l | tr -d ' ')
    local has_tests=false
    local lint_errors=0

    # Check for test directories
    if [[ -d "frontend/__tests__" || -d "frontend/src/__tests__" || -d "backend/tests" || -d "test" || -d "tests" ]]; then
        has_tests=true
    fi

    # Phase-specific requirements checking
    case "$target_phase" in
        "1")
            print_info "Phase 1 Requirements:"

            # Basic linting should work
            if [[ -f "$SCRIPT_DIR/validate-adaptive.sh" ]]; then
                if "$SCRIPT_DIR/validate-adaptive.sh" > /dev/null 2>&1; then
                    echo "  ✅ Basic quality validation passes"
                else
                    echo "  ⚠️  Some quality issues exist (will be addressed for changed files only)"
                    warnings_count=$((warnings_count + 1))
                fi
            fi

            # Pre-commit hooks should be installable
            if [[ -f ".pre-commit-config.yaml" ]]; then
                echo "  ✅ Pre-commit configuration ready"
            else
                echo "  ❌ Pre-commit configuration missing"
                blockers_count=$((blockers_count + 1))
                ready=false
            fi
            ;;

        "2")
            print_info "Phase 2 Requirements:"

            # Should have reasonable test coverage
            if [[ $has_tests == true ]]; then
                echo "  ✅ Test infrastructure detected"
            else
                echo "  ⚠️  Limited test coverage detected (recommended for Phase 2)"
                warnings_count=$((warnings_count + 1))
            fi

            # Repository-wide linting should be manageable
            if [[ $total_files -gt 100 ]]; then
                echo "  ⚠️  Large codebase ($total_files files) - expect longer CI times"
                warnings_count=$((warnings_count + 1))
            else
                echo "  ✅ Manageable codebase size ($total_files files)"
            fi

            # Check if current validation passes
            if [[ -f "$SCRIPT_DIR/validate-adaptive.sh" ]]; then
                if "$SCRIPT_DIR/validate-adaptive.sh" > /dev/null 2>&1; then
                    echo "  ✅ Ready for repository-wide enforcement"
                else
                    echo "  ⚠️  Quality issues exist - will require repository-wide fixes"
                    warnings_count=$((warnings_count + 1))
                fi
            fi
            ;;

        "3")
            print_info "Phase 3 Requirements:"

            # Must have comprehensive tests
            if [[ $has_tests == true ]]; then
                echo "  ✅ Test infrastructure ready for strict enforcement"
            else
                echo "  ❌ Comprehensive tests required for Phase 3"
                blockers_count=$((blockers_count + 1))
                ready=false
            fi

            # Must pass all current quality checks
            if [[ -f "$SCRIPT_DIR/validate-adaptive.sh" ]]; then
                if "$SCRIPT_DIR/validate-adaptive.sh" > /dev/null 2>&1; then
                    echo "  ✅ All quality gates currently passing"
                else
                    echo "  ❌ Quality gates must pass before Phase 3"
                    blockers_count=$((blockers_count + 1))
                    ready=false
                fi
            fi

            # Warn about strict enforcement
            echo "  ⚠️  Phase 3 enables maximum strictness - no bypass options"
            warnings_count=$((warnings_count + 1))
            ;;
    esac

    echo ""

    # Summary
    if [[ $blockers_count -gt 0 ]]; then
        print_error "❌ $blockers_count blocker(s) prevent advancement to Phase $target_phase"
        echo ""
        print_info "🔧 Recommended actions:"
        print_info "1. Address the blockers listed above"
        print_info "2. Run './scripts/quality-gate-manager.sh check' to validate fixes"
        print_info "3. Try advancement again once issues are resolved"
        return 1
    elif [[ $warnings_count -gt 0 ]]; then
        print_warning "⚠️  $warnings_count warning(s) for Phase $target_phase advancement"
        echo ""
        print_info "Phase $target_phase advancement is possible but may require additional work:"
        return 2
    else
        print_success "✅ Ready for Phase $target_phase advancement"
        return 0
    fi
}

# Advance to next phase with safety checks
advance_to_next_phase() {
    local current_phase=$(get_current_phase)
    local next_phase=$((current_phase + 1))

    if [[ $next_phase -gt 3 ]]; then
        print_error "Already at maximum phase (3). Cannot advance further."
        return 1
    fi

    print_header "🚀 Phase Advancement Check: $current_phase → $next_phase"

    # Check readiness first
    local readiness_result
    check_readiness_for_phase "$next_phase"
    readiness_result=$?

    if [[ $readiness_result -eq 1 ]]; then
        # Blockers present, cannot advance
        print_error "Cannot advance due to blockers. Address issues and try again."
        return 1
    fi

    echo ""

    # Show what the next phase means
    case "$next_phase" in
        "1")
            print_info "🎯 Target: Phase 1 (Changed-Code-Only Enforcement)"
            echo "  • Strict quality rules apply to newly modified files"
            echo "  • Legacy files generate warnings but don't block CI/CD"
            echo "  • MyPy/TypeScript checking for new/modified files only"
            echo "  • Perfect new code, gradual legacy improvement"
            ;;
        "2")
            print_info "🎯 Target: Phase 2 (Repository-Wide + Ratcheting)"
            echo "  • Quality rules apply to the entire repository"
            echo "  • Coverage ratcheting requires gradual improvement"
            echo "  • All linting tools scan the full codebase"
            echo "  • Systematic improvement across entire project"
            ;;
        "3")
            print_info "🎯 Target: Phase 3 (Full Strict Enforcement)"
            echo "  • Maximum strictness for all quality tools"
            echo "  • All quality gates blocking with no bypasses"
            echo "  • Branch protection rules recommended"
            echo "  • Production-ready quality standards"
            ;;
    esac

    echo ""

    # Show estimated timeline
    local timeline=""
    case "$next_phase" in
        "1") timeline="1-2 weeks (depends on development velocity)" ;;
        "2") timeline="2-4 weeks (depends on tech debt)" ;;
        "3") timeline="Ongoing maintenance" ;;
    esac
    print_info "📅 Typical phase duration: $timeline"

    echo ""
    read -p "Continue with phase advancement? [y/N]: " -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Phase advancement cancelled"
        return 0
    fi

    # Update configuration
    update_phase_config "$next_phase"
    print_success "Updated .quality-config.yaml → Phase $next_phase"

    # Regenerate configurations based on new phase
    if [[ -f "$SCRIPT_DIR/generate-config.sh" ]]; then
        print_info "Regenerating CI/CD workflows for Phase $next_phase..."
        "$SCRIPT_DIR/generate-config.sh" 2>/dev/null || print_warning "Could not regenerate workflows automatically"
        print_success "Configurations updated"
    fi

    echo ""
    print_success "🎉 Successfully advanced to Phase $next_phase!"
    echo ""
    print_info "📋 Next Steps:"
    print_info "1. Test the new quality gates: ./scripts/validate-adaptive.sh"
    print_info "2. Check phase requirements: ./scripts/quality-gate-manager.sh check"
    print_info "3. Monitor quality metrics and address any issues"

    if [[ $next_phase -eq 3 ]]; then
        echo ""
        print_info "🔒 Phase 3 Recommendations:"
        print_info "• Enable branch protection rules in your repository"
        print_info "• Set up automated quality monitoring"
        print_info "• Document the quality standards for your team"
    fi
}

# Set specific phase
set_specific_phase() {
    local target_phase=$1
    local current_phase=$(get_current_phase)

    if [[ -z "$target_phase" || ! "$target_phase" =~ ^[0-3]$ ]]; then
        print_error "Invalid phase. Must be 0, 1, 2, or 3"
        return 1
    fi

    if [[ $target_phase -eq $current_phase ]]; then
        print_info "Already at Phase $target_phase"
        return 0
    fi

    print_header "🎯 Setting Phase: $current_phase → $target_phase"

    # Warn if skipping phases
    if [[ $target_phase -gt $((current_phase + 1)) ]]; then
        print_warning "Skipping phases $((current_phase + 1)) to $((target_phase - 1))"
        print_warning "This may introduce aggressive quality enforcement"
        echo ""
        read -p "Are you sure you want to skip intermediate phases? [y/N]: " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Phase change cancelled"
            return 0
        fi
    elif [[ $target_phase -lt $current_phase ]]; then
        print_warning "Rolling back from Phase $current_phase to Phase $target_phase"
        print_info "This will relax quality enforcement"
        echo ""
        read -p "Continue with rollback? [y/N]: " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Phase rollback cancelled"
            return 0
        fi
    fi

    # Update configuration
    update_phase_config "$target_phase"
    print_success "Updated .quality-config.yaml → Phase $target_phase"

    # Regenerate configurations
    if [[ -f "$SCRIPT_DIR/generate-config.sh" ]]; then
        print_info "Regenerating configurations for Phase $target_phase..."
        "$SCRIPT_DIR/generate-config.sh" 2>/dev/null || print_warning "Could not regenerate workflows automatically"
        print_success "Configurations updated"
    fi

    echo ""
    print_success "🎉 Successfully set to Phase $target_phase!"
}

# Comprehensive baseline establishment with metrics capture
establish_baseline() {
    print_header "📊 Establishing Comprehensive Quality Baseline"

    print_info "Capturing current project state as quality baseline..."
    echo ""

    # Capture comprehensive metrics
    local baseline_date=$(date '+%Y-%m-%d %H:%M:%S')
    local total_files=0
    local python_files=0
    local ts_files=0
    local js_files=0
    local test_files=0

    # File counts
    python_files=$(find . -name "*.py" -not -path "./node_modules/*" -not -path "./.venv/*" -not -path "./__pycache__/*" 2>/dev/null | wc -l | tr -d ' ')
    ts_files=$(find . -name "*.ts" -o -name "*.tsx" -not -path "./node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
    js_files=$(find . -name "*.js" -o -name "*.jsx" -not -path "./node_modules/*" -not -path "./dist/*" 2>/dev/null | wc -l | tr -d ' ')
    test_files=$(find . -name "*test*.py" -o -name "*test*.ts" -o -name "*test*.tsx" -o -name "*test*.js" -o -name "*test*.jsx" -o -name "*.spec.*" -not -path "./node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
    total_files=$((python_files + ts_files + js_files))

    print_info "📋 Baseline Metrics Captured:"
    echo "  • Total code files: $total_files"
    echo "  • Python files: $python_files"
    echo "  • TypeScript files: $ts_files"
    echo "  • JavaScript files: $js_files"
    echo "  • Test files: $test_files"

    # Quality tool analysis
    local flake8_errors=0
    local ts_errors=0
    local eslint_errors=0
    local mypy_errors=0

    print_info ""
    print_info "🔍 Quality Tool Baseline:"

    # Python quality baseline
    if [[ $python_files -gt 0 ]]; then
        if command -v flake8 >/dev/null 2>&1; then
            flake8_errors=$(flake8 . 2>/dev/null | wc -l | tr -d ' ')
            echo "  • flake8 issues: $flake8_errors"
        else
            echo "  • flake8: not available"
        fi

        if command -v mypy >/dev/null 2>&1; then
            mypy_errors=$(mypy . 2>/dev/null | grep -c "error:" || echo "0")
            echo "  • MyPy issues: $mypy_errors"
        else
            echo "  • MyPy: not available"
        fi

        # Type hints coverage
        local typed_py_files=$(find . -name "*.py" -not -path "./node_modules/*" -not -path "./.venv/*" -exec grep -l ":" {} \; 2>/dev/null | wc -l | tr -d ' ')
        local typing_coverage=0
        if [[ $python_files -gt 0 ]]; then
            typing_coverage=$((typed_py_files * 100 / python_files))
            echo "  • Python typing coverage: ${typing_coverage}%"
        fi
    fi

    # TypeScript quality baseline
    if [[ $ts_files -gt 0 ]]; then
        if command -v tsc >/dev/null 2>&1 && [[ -f "tsconfig.json" || -f "frontend/tsconfig.json" ]]; then
            if [[ -f "frontend/tsconfig.json" ]]; then
                ts_errors=$(cd frontend && tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            else
                ts_errors=$(tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            fi
            echo "  • TypeScript errors: $ts_errors"
        else
            echo "  • TypeScript: not available or not configured"
        fi
    fi

    # ESLint baseline
    if [[ $js_files -gt 0 || $ts_files -gt 0 ]]; then
        if command -v npx >/dev/null 2>&1 && [[ -f "package.json" ]]; then
            eslint_errors=$(npx eslint . 2>/dev/null | grep -c "error" || echo "0")
            echo "  • ESLint errors: $eslint_errors"
        else
            echo "  • ESLint: not available"
        fi
    fi

    local total_issues=$((flake8_errors + ts_errors + eslint_errors + mypy_errors))
    echo "  • Total quality issues: $total_issues"

    # Test coverage baseline
    print_info ""
    print_info "🧪 Testing Baseline:"
    local test_coverage=0.0

    if [[ $test_files -gt 0 ]]; then
        local test_coverage_ratio=$((test_files * 100 / (total_files + 1)))
        echo "  • Test file ratio: ${test_coverage_ratio}%"

        # Try to get actual coverage if tools are available
        if command -v pytest >/dev/null 2>&1 && [[ -f "pytest.ini" || -f "pyproject.toml" ]]; then
            echo "  • pytest available for coverage analysis"
        fi
        if command -v npm >/dev/null 2>&1 && [[ -f "package.json" ]]; then
            echo "  • npm test available for coverage analysis"
        fi
    else
        echo "  • No test files detected"
    fi

    # Security baseline
    print_info ""
    print_info "🔒 Security Baseline:"
    local security_issues=0

    if command -v detect-secrets >/dev/null 2>&1; then
        security_issues=$(detect-secrets scan --all-files 2>/dev/null | grep -c "potential secret" || echo "0")
        echo "  • Potential secrets detected: $security_issues"
    else
        echo "  • detect-secrets: not available"
    fi

    # Update .quality-config.yaml with baseline data
    print_info ""
    print_info "💾 Updating baseline configuration..."

    # Use Python to update the YAML with baseline data
    # Try python3 first, fall back to python
    if command -v python3 >/dev/null 2>&1; then
        python3 << 'EOF'
import yaml
import sys
import os

config_file = "$QUALITY_CONFIG_FILE"
if not os.path.exists(config_file):
    print("Warning: .quality-config.yaml not found, creating basic structure")
    config = {
        'quality_gates': {'current_phase': 0},
        'baseline': {}
    }
else:
    try:
        with open(config_file, 'r') as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        print(f"Warning: Could not parse existing config: {e}")
        config = {'quality_gates': {'current_phase': 0}}

# Ensure baseline section exists
if 'baseline' not in config:
    config['baseline'] = {}

# Update baseline with captured metrics
config['baseline'] = {
    'established_date': '$baseline_date',
    'initial_metrics': {
        'total_files': $total_files,
        'python_files': $python_files,
        'typescript_files': $ts_files,
        'javascript_files': $js_files,
        'test_files': $test_files,
        'typing_coverage': $typing_coverage if '$python_files' != '0' else 0,
        'total_quality_issues': $total_issues,
        'frontend_errors': {
            'typescript': $ts_errors,
            'eslint': $eslint_errors
        },
        'backend_errors': {
            'flake8': $flake8_errors,
            'mypy': $mypy_errors
        },
        'security_issues': $security_issues,
        'test_coverage': $test_coverage
    },
    'regression_thresholds': {
        'max_additional_errors': 0,  # No new errors allowed
        'min_test_coverage': $test_coverage,
        'allow_temporary_regressions': False
    },
    'baseline_validation_passed': $(if "$SCRIPT_DIR/validate-adaptive.sh" >/dev/null 2>&1; then echo "True"; else echo "False"; fi)
}

# Write updated config
try:
    with open(config_file, 'w') as f:
        yaml.dump(config, f, default_flow_style=False, indent=2, sort_keys=False)
    print("✅ Baseline metrics saved to .quality-config.yaml")
except Exception as e:
    print(f"❌ Error saving baseline: {e}")
    sys.exit(1)
EOF
    elif command -v python >/dev/null 2>&1; then
        python << 'EOF'
import yaml
import sys
import os

config_file = "$QUALITY_CONFIG_FILE"
if not os.path.exists(config_file):
    print("Warning: .quality-config.yaml not found, creating basic structure")
    config = {
        'quality_gates': {'current_phase': 0},
        'baseline': {}
    }
else:
    try:
        with open(config_file, 'r') as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        print(f"Warning: Could not parse existing config: {e}")
        config = {'quality_gates': {'current_phase': 0}}

# Ensure baseline section exists
if 'baseline' not in config:
    config['baseline'] = {}

# Update baseline with captured metrics
config['baseline'] = {
    'established_date': '$baseline_date',
    'initial_metrics': {
        'total_files': $total_files,
        'python_files': $python_files,
        'typescript_files': $ts_files,
        'javascript_files': $js_files,
        'test_files': $test_files,
        'typing_coverage': $typing_coverage if '$python_files' != '0' else 0,
        'total_quality_issues': $total_issues,
        'frontend_errors': {
            'typescript': $ts_errors,
            'eslint': $eslint_errors
        },
        'backend_errors': {
            'flake8': $flake8_errors,
            'mypy': $mypy_errors
        },
        'security_issues': $security_issues,
        'test_coverage': $test_coverage
    },
    'regression_thresholds': {
        'max_additional_errors': 0,  # No new errors allowed
        'min_test_coverage': $test_coverage,
        'allow_temporary_regressions': False
    },
    'baseline_validation_passed': $(if "$SCRIPT_DIR/validate-adaptive.sh" >/dev/null 2>&1; then echo "True"; else echo "False"; fi)
}

# Write updated config
try:
    with open(config_file, 'w') as f:
        yaml.dump(config, f, default_flow_style=False, indent=2, sort_keys=False)
    print("✅ Baseline metrics saved to .quality-config.yaml")
except Exception as e:
    print(f"❌ Error saving baseline: {e}")
    sys.exit(1)
EOF
    else
        print_error "Python not found - cannot update baseline configuration"
        return 1
    fi

    local python_result=$?

    if [[ $python_result -eq 0 ]]; then
        print_success "✅ Quality baseline successfully established!"
        echo ""
        print_info "📊 Baseline Summary:"
        echo "  • Date: $baseline_date"
        echo "  • Files tracked: $total_files code files, $test_files test files"
        echo "  • Quality issues documented: $total_issues"
        echo "  • Security baseline: $security_issues potential issues"
        echo ""
        print_info "🛡️ Regression Protection Active:"
        echo "  • No additional quality issues allowed beyond baseline"
        echo "  • Test coverage must be maintained or improved"
        echo "  • Security issues cannot increase"
        echo ""
        print_info "📋 Next Steps:"
        echo "  1. Run './scripts/quality-gate-manager.sh check' to validate against baseline"
        echo "  2. Use './scripts/quality-gate-manager.sh advance' when ready to progress phases"
        echo "  3. All commits will be checked against this baseline to prevent regressions"
    else
        print_error "❌ Failed to save baseline metrics"
        print_info "Baseline has been analyzed but could not be saved to configuration"
        print_info "Manual baseline documentation:"
        echo "  • Files: $total_files total, $test_files tests"
        echo "  • Issues: $total_issues total quality issues"
        echo "  • Date: $baseline_date"
    fi
}

# Helper function to check if baseline exists
check_baseline_exists() {
    # Try to check using python3 first, then python
    local result
    result=$(python3 -c "
import yaml
import sys
import os

config_file = '$QUALITY_CONFIG_FILE'
try:
    with open(config_file, 'r') as f:
        config = yaml.safe_load(f) or {}

    if 'baseline' in config and 'initial_metrics' in config['baseline']:
        print('true')
    else:
        print('false')
except:
    print('false')
" 2>/dev/null)

    if [[ "$result" == "true" ]]; then
        echo "true"
        return 0
    fi

    # Try python2 as fallback
    result=$(python -c "
import yaml
import sys
import os

config_file = '$QUALITY_CONFIG_FILE'
try:
    with open(config_file, 'r') as f:
        config = yaml.safe_load(f) or {}

    if 'baseline' in config and 'initial_metrics' in config['baseline']:
        print('true')
    else:
        print('false')
except:
    print('false')
" 2>/dev/null)

    if [[ "$result" == "true" ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# Helper function to compare current metrics with baseline
compare_with_baseline() {
    local current_flake8=$1
    local current_ts=$2
    local current_eslint=$3
    local current_mypy=$4
    local current_security=$5
    local current_total=$6

    # Use Python to compare metrics (try Python 3 first)
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import yaml
import sys

try:
    with open('$QUALITY_CONFIG_FILE', 'r') as f:
        config = yaml.safe_load(f) or {}

    baseline = config.get('baseline', {}).get('initial_metrics', {})

    # Get baseline values
    baseline_flake8 = baseline.get('backend_errors', {}).get('flake8', 0)
    baseline_ts = baseline.get('frontend_errors', {}).get('typescript', 0)
    baseline_eslint = baseline.get('frontend_errors', {}).get('eslint', 0)
    baseline_mypy = baseline.get('backend_errors', {}).get('mypy', 0)
    baseline_security = baseline.get('security_issues', 0)

    current_flake8 = $current_flake8
    current_ts = $current_ts
    current_eslint = $current_eslint
    current_mypy = $current_mypy
    current_security = $current_security

    print('📊 Regression Analysis:')
    print(f'  • flake8: {baseline_flake8} → {current_flake8}')
    print(f'  • TypeScript: {baseline_ts} → {current_ts}')
    print(f'  • ESLint: {baseline_eslint} → {current_eslint}')
    print(f'  • MyPy: {baseline_mypy} → {current_mypy}')
    print(f'  • Security: {baseline_security} → {current_security}')

    # Check for regressions (simplified)
    regressions = 0
    if current_flake8 > baseline_flake8: regressions += 1
    if current_ts > baseline_ts: regressions += 1
    if current_eslint > baseline_eslint: regressions += 1
    if current_mypy > baseline_mypy: regressions += 1
    if current_security > baseline_security: regressions += 1

    if regressions > 0:
        print('❌ REGRESSIONS DETECTED')
        sys.exit(1)
    else:
        print('✅ NO REGRESSIONS')
        sys.exit(0)

except Exception as e:
    print(f'⚠️  Baseline comparison failed: {e}')
    sys.exit(2)
" 2>/dev/null
    else
        # Fallback if no Python 3
        echo "⚠️  Python not available for regression analysis"
        return 2
    fi
}

# Comprehensive phase requirements and regression checking
check_phase_requirements() {
    local current_phase=$(get_current_phase)

    print_header "✅ Phase $current_phase Requirements & Regression Check"

    local all_requirements_met=true
    local regression_detected=false

    # First check if we have a baseline established
    local has_baseline=false
    if [[ -f "$QUALITY_CONFIG_FILE" ]]; then
        has_baseline=$(check_baseline_exists)
    fi

    if [[ $has_baseline == true ]]; then
        print_info "🛡️  Checking for regressions from established baseline..."
        echo ""

        # Get current metrics for comparison
        local current_flake8_errors=0
        local current_ts_errors=0
        local current_eslint_errors=0
        local current_mypy_errors=0
        local current_security_issues=0

        # Count current issues
        if command -v flake8 >/dev/null 2>&1; then
            current_flake8_errors=$(flake8 . 2>/dev/null | wc -l | tr -d ' ')
        fi

        if command -v tsc >/dev/null 2>&1 && [[ -f "tsconfig.json" || -f "frontend/tsconfig.json" ]]; then
            if [[ -f "frontend/tsconfig.json" ]]; then
                current_ts_errors=$(cd frontend && tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            else
                current_ts_errors=$(tsc --noEmit 2>&1 | grep -c "error TS" 2>/dev/null || echo "0")
            fi
        fi

        if command -v npx >/dev/null 2>&1 && [[ -f "package.json" ]]; then
            current_eslint_errors=$(npx eslint . 2>/dev/null | grep -c "error" || echo "0")
        fi

        if command -v mypy >/dev/null 2>&1; then
            current_mypy_errors=$(mypy . 2>/dev/null | grep -c "error:" || echo "0")
        fi

        if command -v detect-secrets >/dev/null 2>&1; then
            current_security_issues=$(detect-secrets scan --all-files 2>/dev/null | grep -c "potential secret" || echo "0")
        fi

        local current_total=$((current_flake8_errors + current_ts_errors + current_eslint_errors + current_mypy_errors))

        # Compare with baseline using Python
        local regression_check_result
        regression_check_result=$(compare_with_baseline $current_flake8_errors $current_ts_errors $current_eslint_errors $current_mypy_errors $current_security_issues $current_total)
        local regression_check_result=$?

        if [[ $regression_check_result -eq 1 ]]; then
            regression_detected=true
            all_requirements_met=false
        elif [[ $regression_check_result -eq 2 ]]; then
            print_warning "Could not perform regression check - continuing with quality validation"
        fi

    else
        print_info "⚠️  No baseline established yet"
        print_info "Run './scripts/quality-gate-manager.sh baseline' to establish quality baseline"
        echo ""
    fi

    # Run current phase validation
    print_info "🔍 Phase $current_phase Quality Validation:"

    if [[ -f "$SCRIPT_DIR/validate-adaptive.sh" ]]; then
        if "$SCRIPT_DIR/validate-adaptive.sh"; then
            print_success "✅ All Phase $current_phase quality checks passed"
        else
            print_warning "❌ Some Phase $current_phase quality checks failed"
            all_requirements_met=false
            print_info "Address quality issues before considering phase advancement"
        fi
    else
        print_warning "validate-adaptive.sh not found - cannot perform quality validation"
        all_requirements_met=false
    fi

    echo ""

    # Overall assessment
    if [[ $all_requirements_met == true && $regression_detected == false ]]; then
        print_success "🎉 ALL REQUIREMENTS SATISFIED"
        echo ""
        print_info "📊 Current Status:"
        echo "  ✅ No regressions from baseline"
        echo "  ✅ All Phase $current_phase quality checks passed"
        echo "  ✅ Ready for normal development workflow"

        # Suggest phase advancement if applicable
        if [[ $current_phase -lt 3 ]]; then
            echo ""
            print_info "🚀 Phase Advancement Opportunity:"
            print_info "Your project meets all Phase $current_phase requirements!"
            print_info "Consider advancing to Phase $((current_phase + 1)) when ready:"
            print_info "  ./scripts/quality-gate-manager.sh advance"
        fi

        return 0

    else
        print_error "❌ REQUIREMENTS NOT MET"
        echo ""
        print_info "🔧 Issues to resolve:"

        if [[ $regression_detected == true ]]; then
            echo "  • Fix quality regressions from baseline"
        fi

        if [[ $all_requirements_met == false ]]; then
            echo "  • Address quality validation failures"
        fi

        echo ""
        print_info "📋 Recommended actions:"
        print_info "1. Fix the issues identified above"
        print_info "2. Run './scripts/validate-adaptive.sh' to test fixes"
        print_info "3. Re-run this check: './scripts/quality-gate-manager.sh check'"

        return 1
    fi
}

# Main command router
main() {
    case "${1:-status}" in
        "status")
            show_phase_status
            ;;
        "analyze")
            analyze_project_for_phase
            ;;
        "advance")
            advance_to_next_phase
            ;;
        "set-phase")
            if [[ -z "$2" ]]; then
                print_error "Phase number required (0-3)"
                exit 1
            fi
            set_specific_phase "$2"
            ;;
        "rollback")
            local current_phase=$(get_current_phase)
            local prev_phase=$((current_phase - 1))
            if [[ $prev_phase -ge 0 ]]; then
                set_specific_phase "$prev_phase"
            else
                print_warning "Already at minimum phase (0)"
            fi
            ;;
        "baseline")
            establish_baseline
            ;;
        "check")
            check_phase_requirements
            ;;
        "help"|"--help"|"-h")
            echo "Quality Gate Phase Manager - Graduated Enforcement System"
            echo ""
            echo "USAGE:"
            echo "  $0 <command> [arguments]"
            echo ""
            echo "COMMANDS:"
            echo "  status              Show current phase and progression information"
            echo "  analyze             Analyze project and recommend starting phase"
            echo "  advance             Move to the next quality gate phase"
            echo "  set-phase <0-3>     Set specific phase (0=Baseline, 1=Changed-only, 2=Ratchet, 3=Strict)"
            echo "  rollback            Go back one phase if current is too aggressive"
            echo "  baseline            Establish quality baseline for current codebase"
            echo "  check               Check if current phase requirements are met"
            echo "  help                Show this help message"
            echo ""
            echo "PHASES:"
            echo "  0  Baseline & Stabilization       - Prevent regressions, document current state"
            echo "  1  Changed-Code-Only Enforcement  - Strict rules for new/modified files only"
            echo "  2  Repository-Wide + Ratcheting   - Full enforcement with gradual improvements"
            echo "  3  Full Strict Enforcement        - Maximum quality standards, zero tolerance"
            echo ""
            echo "EXAMPLES:"
            echo "  $0 status           # Show current phase status"
            echo "  $0 analyze          # Get phase recommendation for current project"
            echo "  $0 advance          # Move to next phase"
            echo "  $0 set-phase 2      # Jump directly to Phase 2"
            ;;
        *)
            print_error "Unknown command: $1"
            echo ""
            echo "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
