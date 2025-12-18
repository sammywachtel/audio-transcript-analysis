#!/bin/bash
# CI/CD Setup Verification Script
# Verifies all required secrets and configurations are in place for deployment

set -e

echo "🔍 CI/CD Setup Verification"
echo "=============================="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track overall status
ALL_CHECKS_PASSED=true

check_gcloud() {
    if command -v gcloud &> /dev/null; then
        echo -e "${GREEN}✓${NC} gcloud CLI installed"
    else
        echo -e "${RED}✗${NC} gcloud CLI not found - install from https://cloud.google.com/sdk/docs/install"
        ALL_CHECKS_PASSED=false
    fi
}

check_project() {
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
    if [ -n "$PROJECT_ID" ]; then
        echo -e "${GREEN}✓${NC} GCP project configured: $PROJECT_ID"
    else
        echo -e "${RED}✗${NC} No GCP project configured - run: gcloud config set project PROJECT_ID"
        ALL_CHECKS_PASSED=false
    fi
}

check_apis() {
    echo ""
    echo "Checking required APIs..."

    REQUIRED_APIS=(
        "cloudbuild.googleapis.com"
        "run.googleapis.com"
        "secretmanager.googleapis.com"
        "iamcredentials.googleapis.com"
    )

    for API in "${REQUIRED_APIS[@]}"; do
        if gcloud services list --enabled --filter="name:$API" --format="value(name)" 2>/dev/null | grep -q "$API"; then
            echo -e "  ${GREEN}✓${NC} $API"
        else
            echo -e "  ${RED}✗${NC} $API not enabled - run: gcloud services enable $API"
            ALL_CHECKS_PASSED=false
        fi
    done
}

check_secrets() {
    echo ""
    echo "Checking Secret Manager secrets..."

    if gcloud secrets describe REPLICATE_API_TOKEN &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} REPLICATE_API_TOKEN exists in Secret Manager"

        # Check if service account has access
        SA_EMAIL=$(gcloud config get-value account 2>/dev/null)
        if gcloud secrets get-iam-policy REPLICATE_API_TOKEN --format="value(bindings.members)" 2>/dev/null | grep -q "secretAccessor"; then
            echo -e "  ${GREEN}✓${NC} Secret has secretAccessor role binding"
        else
            echo -e "  ${YELLOW}⚠${NC}  Warning: No secretAccessor role binding found"
        fi
    else
        echo -e "  ${RED}✗${NC} REPLICATE_API_TOKEN not found in Secret Manager"
        echo "      Create it with: echo -n 'your-token' | gcloud secrets create REPLICATE_API_TOKEN --data-file=-"
        ALL_CHECKS_PASSED=false
    fi
}

check_service_account() {
    echo ""
    echo "Checking deployment service account..."

    # Try to find service account with "github-actions" in name
    SA=$(gcloud iam service-accounts list --filter="email:github-actions*" --format="value(email)" 2>/dev/null | head -1)

    if [ -n "$SA" ]; then
        echo -e "  ${GREEN}✓${NC} Service account found: $SA"

        # Check roles
        PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
        ROLES=$(gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" --filter="bindings.members:serviceAccount:$SA" --format="value(bindings.role)" 2>/dev/null)

        if echo "$ROLES" | grep -q "roles/run.admin"; then
            echo -e "  ${GREEN}✓${NC} Has roles/run.admin"
        else
            echo -e "  ${RED}✗${NC} Missing roles/run.admin"
            ALL_CHECKS_PASSED=false
        fi

        if echo "$ROLES" | grep -q "roles/storage.admin"; then
            echo -e "  ${GREEN}✓${NC} Has roles/storage.admin"
        else
            echo -e "  ${YELLOW}⚠${NC}  Missing roles/storage.admin (may be needed)"
        fi
    else
        echo -e "  ${YELLOW}⚠${NC}  No service account found with 'github-actions' in name"
        echo "      This is normal if you're using a different name"
    fi
}

check_workload_identity() {
    echo ""
    echo "Checking Workload Identity Pool..."

    if gcloud iam workload-identity-pools list --location=global --format="value(name)" 2>/dev/null | grep -q "github"; then
        echo -e "  ${GREEN}✓${NC} Workload Identity Pool exists"

        # Check provider
        if gcloud iam workload-identity-pools providers list --workload-identity-pool=github-actions --location=global --format="value(name)" 2>/dev/null | grep -q "github"; then
            echo -e "  ${GREEN}✓${NC} OIDC Provider configured"
        fi
    else
        echo -e "  ${YELLOW}⚠${NC}  No Workload Identity Pool found"
        echo "      See docs/CLOUD_RUN_DEPLOYMENT.md for setup instructions"
    fi
}

check_github_workflow() {
    echo ""
    echo "Checking GitHub Actions workflow..."

    if [ -f ".github/workflows/deploy.yml" ]; then
        echo -e "  ${GREEN}✓${NC} deploy.yml exists"

        # Check for both jobs
        if grep -q "deploy-frontend:" ".github/workflows/deploy.yml"; then
            echo -e "  ${GREEN}✓${NC} Frontend deployment job configured"
        else
            echo -e "  ${RED}✗${NC} Frontend deployment job not found"
            ALL_CHECKS_PASSED=false
        fi

        if grep -q "deploy-alignment-service:" ".github/workflows/deploy.yml"; then
            echo -e "  ${GREEN}✓${NC} Alignment service deployment job configured"
        else
            echo -e "  ${RED}✗${NC} Alignment service deployment job not found"
            ALL_CHECKS_PASSED=false
        fi
    else
        echo -e "  ${RED}✗${NC} .github/workflows/deploy.yml not found"
        ALL_CHECKS_PASSED=false
    fi
}

check_cloudbuild_configs() {
    echo ""
    echo "Checking Cloud Build configurations..."

    if [ -f "cloudbuild.yaml" ]; then
        echo -e "  ${GREEN}✓${NC} Root cloudbuild.yaml exists (frontend)"
    else
        echo -e "  ${RED}✗${NC} cloudbuild.yaml not found"
        ALL_CHECKS_PASSED=false
    fi

    if [ -f "alignment-service/cloudbuild.yaml" ]; then
        echo -e "  ${GREEN}✓${NC} alignment-service/cloudbuild.yaml exists"
    else
        echo -e "  ${RED}✗${NC} alignment-service/cloudbuild.yaml not found"
        ALL_CHECKS_PASSED=false
    fi
}

# Run all checks
check_gcloud
check_project
check_apis
check_secrets
check_service_account
check_workload_identity
check_github_workflow
check_cloudbuild_configs

# Summary
echo ""
echo "=============================="
if [ "$ALL_CHECKS_PASSED" = true ]; then
    echo -e "${GREEN}✓ All critical checks passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Configure GitHub secrets (see docs/CLOUD_RUN_DEPLOYMENT.md)"
    echo "2. Push to main branch to trigger deployment"
    echo "3. Monitor deployment in GitHub Actions tab"
else
    echo -e "${RED}✗ Some checks failed${NC}"
    echo ""
    echo "Review the errors above and see docs/CLOUD_RUN_DEPLOYMENT.md for setup instructions"
    exit 1
fi
