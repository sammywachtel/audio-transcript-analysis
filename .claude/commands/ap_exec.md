---
description: Execute one iteration - implement changes, validate, and document results
argument-hint: [scope] [iteration]
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Task(*), SlashCommand(*)
---

## Your Role

You are the implementation agent executing a planned iteration. Your job: read the plan, implement the changes, validate your work, and document the results.

## Workflow Overview

1. **Load Context** - Read the iteration plan
2. **Implement** - Make the code changes
3. **Validate** - Verify your work (hook fires automatically)
4. **Document** - Create results.md (via /ap_iteration_results)
5. **Report** - Summarize completion status

---

## Step 1: Load Context

**Read the iteration plan:**
```bash
.agent_process/work/{scope}/iteration_plan.md
```

**Extract from the plan:**
- Acceptance Criteria (LOCKED - these are your requirements)
- Technical Assessment (implementation guidance from orchestrator)
- Files in Scope (what you're allowed to change)
- Validation Requirements (how to verify your work)
- Out of Scope (what NOT to do)

**If this is a sub-iteration (iteration_01_a/b/c), ALSO read:**

Sub-iterations focus on specific fixes from orchestrator review. Load these additional files:

1. **Current iteration placeholder** (created by orchestrator):
   ```bash
   .agent_process/work/{scope}/{iteration}/results.md
   ```
   **Extract:**
   - Required fixes (1-3 specific issues to address)
   - What the orchestrator found incomplete

2. **Previous iteration results** (what was already tried):
   ```bash
   .agent_process/work/{scope}/{parent_iteration}/results.md
   ```
   Where `{parent_iteration}` is:
   - iteration_01_a → read iteration_01/results.md
   - iteration_01_b → read iteration_01_a/results.md
   - iteration_01_c → read iteration_01_b/results.md

   **Extract:**
   - What was already implemented (don't break these parts)
   - What didn't work (don't repeat mistakes)

**Focus for sub-iterations:**
- Address the 1-3 specific fixes from orchestrator review
- Build on what already works
- Don't re-attempt everything from scratch

**Check for vague instructions (CRITICAL):**

If the required fixes are too vague, STOP and ask the human for clarification.

**Vague indicators (ask for clarification):**
- ❌ Line ranges >50 lines (e.g., "lines 152-399")
- ❌ No before/after examples for CSS/markup changes
- ❌ Action verbs without specifics ("scope", "refactor", "improve")
- ❌ "Remaining" or "various" without enumeration
- ❌ Missing specific selector/method/variable names

**Good indicators (proceed):**
- ✅ Small line ranges (<20 lines)
- ✅ Concrete before/after examples
- ✅ Enumerated list of specific items
- ✅ Clear acceptance test provided

**If fixes are vague, respond:**
```markdown
⚠️ Cannot proceed - Required fixes are too vague:

Fix #N is unclear:
- What: [Quote the vague instruction]
- Missing: [What information is needed]

Please provide:
1. Exact line numbers or selector names
2. Before/after example showing the change
3. Clear acceptance test (e.g., "grep should show X")

Example of what I need:
[Provide a specific example based on the vague instruction]
```

**Only proceed if fixes are specific enough to execute confidently.**

**Create iteration folder if needed:**
```bash
mkdir -p .agent_process/work/{scope}/{iteration}
```

**Ensure you're on the correct branch:**

The scope work must happen on a branch named `scope/{scope}`. Check current branch and create/checkout if needed:

```bash
# Check if we're on the correct branch
EXPECTED_BRANCH="scope/{scope}"
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then
  echo "⚠️  Not on branch $EXPECTED_BRANCH (currently on: $CURRENT_BRANCH)"

  # Check if the branch exists
  if git show-ref --verify --quiet "refs/heads/$EXPECTED_BRANCH"; then
    echo "✅ Branch exists, checking out $EXPECTED_BRANCH"
    git checkout "$EXPECTED_BRANCH"
  else
    echo "✅ Creating and checking out new branch $EXPECTED_BRANCH"
    git checkout -b "$EXPECTED_BRANCH"
  fi
else
  echo "✅ Already on correct branch: $EXPECTED_BRANCH"
fi
```

**Why this matters:**
- Keeps scope work isolated
- Makes it easy to identify what branch corresponds to which scope
- Enables clean PR workflow (one scope per PR)
- Prevents accidental work on wrong branch

---

## Step 1.5: Select Specialized Agent (MANDATORY)

**You MUST spawn a specialized agent for implementation. Direct implementation without an agent is NOT allowed.**

The agent process has access to specialized agents optimized for different types of work. Analyze the scope and select the most appropriate agent using the framework below.

**Agent Selection Framework:**

Examine the "Files in Scope" or "Files to Create/Modify" section and match patterns. **Use multiple agents in parallel when the scope spans different domains.**

1. **Analyze files and select agent(s):**

   **Frontend React/TypeScript (MOST COMMON):**
   - React components, hooks, `.tsx`/`.ts` → `frontend-excellence:react-specialist`
   - Lexical editor files, plugins → `frontend-excellence:react-specialist`
   - Component architecture, design systems → `frontend-excellence:component-architect`
   - CSS, Tailwind, styling → `frontend-excellence:css-expert`
   - State management (Redux, Zustand, Context) → `frontend-excellence:state-manager`
   - Frontend performance, Core Web Vitals → `frontend-excellence:frontend-optimizer`

   **Backend/API Development:**
   - Python backend, FastAPI → `backend-security:backend-expert`
   - REST/GraphQL API design → `backend-security:api-architect`
   - Database schemas, migrations → `dev-accelerator:backend-architect`
   - LLM integration, RAG, embeddings → `backend-security:llm-integrator`

   **Testing:**
   - Test files, Jest, Playwright → `dev-accelerator:test-automator`
   - E2E test specs → `dev-accelerator:test-automator`

   **DevOps/Infrastructure:**
   - Terraform, CDK, CloudFormation → `infra-pipeline:infra-architect`
   - CI/CD pipelines, GitHub Actions → `infra-pipeline:cicd-engineer`
   - Docker, deployments → `infra-pipeline:deployment-coordinator`
   - Automation scripts → `infra-pipeline:automation-specialist`

   **Security/Auth:**
   - Authentication (OAuth2, OIDC, JWT) → `backend-security:auth-specialist`
   - Security audits, OWASP → `backend-security:security-guardian`

   **Debugging/Code Quality:**
   - Bug fixes, unexpected behavior → `dev-accelerator:debugger`
   - Code review, refactoring → `dev-accelerator:code-reviewer`
   - TypeScript advanced patterns → `dev-accelerator:typescript-pro`
   - Python optimization → `dev-accelerator:python-pro`

   **Observability/Monitoring:**
   - Monitoring, alerting → `observability-ops:monitor` (then select platform-specific)
   - Logging, log analysis → `observability-ops:log-aggregator`
   - Performance analysis → `observability-ops:performance-analyst`
   - Incident response → `observability-ops:sre-engineer`

2. **Multi-domain scopes → spawn multiple agents in parallel:**

   If the scope includes files from different domains (e.g., frontend + backend + tests), spawn multiple specialized agents in a single response rather than using `general-purpose`.

   Example: Scope includes `frontend/src/components/Settings.tsx` + `backend/app/api/settings.py` + `tests/e2e/settings.spec.ts`
   → Spawn THREE agents in parallel:
   - `frontend-excellence:react-specialist` for the React component
   - `backend-security:backend-expert` for the API endpoint
   - `dev-accelerator:test-automator` for the E2E tests

3. **DEFAULT FALLBACK (only when truly ambiguous):**
   - Can't determine file type at all → `general-purpose`
   - Scope is purely research/exploration → `Explore`

   ⚠️ **Prefer multiple specialized agents over `general-purpose` when possible.**

   ⚠️ **IMPORTANT:** Even if you choose `general-purpose`, you MUST still spawn the agent. Never skip Step 2.

**Selection Output (REQUIRED before Step 2):**

State your selection explicitly. For multi-domain scopes, list ALL agents:
```
Selected Agent(s):
1. {agent_name} - for {file pattern}
2. {agent_name} - for {file pattern}
Reasoning: {brief explanation}
Proceeding to spawn agent(s)...
```

**Example Selections:**

| Files in Scope | Selected Agent(s) | Reasoning |
|----------------|-------------------|-----------|
| `migrations/*.sql` | `dev-accelerator:backend-architect` | Database schema work |
| `frontend/src/hooks/*.ts` | `frontend-excellence:react-specialist` | React hooks |
| `frontend/src/components/lexical/*.tsx` | `frontend-excellence:react-specialist` | Lexical plugin |
| `tests/e2e/*.spec.ts` | `dev-accelerator:test-automator` | E2E tests |
| `backend/app/api/*.py` | `backend-security:api-architect` | API endpoints |
| `.github/workflows/*.yml` | `infra-pipeline:cicd-engineer` | CI/CD pipeline |
| `frontend/*.tsx` + `backend/*.py` | `frontend-excellence:react-specialist` + `backend-security:backend-expert` | **Parallel: 2 agents** |
| `frontend/*.tsx` + `tests/e2e/*.ts` | `frontend-excellence:react-specialist` + `dev-accelerator:test-automator` | **Parallel: 2 agents** |
| `frontend/*.tsx` + `backend/*.py` + `tests/*.ts` | 3 specialized agents in parallel | **Parallel: 3 agents** |

**Available Agent Categories Reference:**

<details>
<summary>Click to expand full agent list</summary>

**Frontend Excellence:**
- `frontend-excellence:react-specialist` - React 19, Next.js 15, modern patterns
- `frontend-excellence:component-architect` - Design systems, component libraries
- `frontend-excellence:css-expert` - Tailwind, CSS-in-JS, responsive design
- `frontend-excellence:state-manager` - Redux, Zustand, Context patterns
- `frontend-excellence:frontend-optimizer` - Core Web Vitals, performance

**Backend & Security:**
- `backend-security:backend-expert` - Node.js, Python, FastAPI
- `backend-security:api-architect` - REST, GraphQL API design
- `backend-security:auth-specialist` - OAuth2, OIDC, JWT
- `backend-security:security-guardian` - OWASP, threat modeling
- `backend-security:llm-integrator` - RAG, embeddings, prompts

**Dev Accelerator:**
- `dev-accelerator:debugger` - Errors, test failures, unexpected behavior
- `dev-accelerator:code-reviewer` - Code quality, security analysis
- `dev-accelerator:test-automator` - Jest, Playwright, test strategies
- `dev-accelerator:backend-architect` - APIs, microservices, databases
- `dev-accelerator:frontend-developer` - React components, UI fixes
- `dev-accelerator:typescript-pro` - Advanced TypeScript patterns
- `dev-accelerator:python-pro` - Python 3.12+, async, FastAPI

**Infrastructure & Pipeline:**
- `infra-pipeline:infra-architect` - Terraform, CDK, AWS
- `infra-pipeline:cicd-engineer` - GitHub Actions, GitLab CI
- `infra-pipeline:deployment-coordinator` - Blue-green, canary deploys
- `infra-pipeline:automation-specialist` - Bash, Python scripts
- `infra-pipeline:gitops-expert` - ArgoCD, Flux

**Observability:**
- `observability-ops:datadog-specialist` - Datadog dashboards, APM
- `observability-ops:cloudwatch-expert` - AWS CloudWatch
- `observability-ops:log-aggregator` - Log management
- `observability-ops:performance-analyst` - APM, tracing
- `observability-ops:sre-engineer` - Incident response, reliability

**General:**
- `general-purpose` - Multi-step tasks, research, multi-domain work
- `Explore` - Codebase exploration, finding files/patterns
- `Plan` - Implementation planning, architecture design

</details>

---

## Step 2: Implement Changes (SPAWN AGENT NOW)

⚠️ **CRITICAL: You MUST call the Task tool in this step. Do NOT implement changes directly.**

If you reach this step without spawning an agent, you are violating the workflow. Go back to Step 1.5 and select an agent, then return here to spawn it.

**Work within the defined scope:**
- Implement ONLY what the acceptance criteria require
- Follow the Technical Assessment guidance
- Modify ONLY files listed in "Files in Scope"
- Do NOT expand scope beyond locked criteria
- If you discover a change is impossible without touching an out-of-scope file, STOP and ask the orchestrator to update the scope before editing anything else

**Add/update tests:**
- Write tests for new functionality
- Update existing tests for modified behavior
- Ensure tests are comprehensive and meaningful

**MANDATORY: Use Task tool with selected agent(s):**

You MUST launch the specialized agent(s) determined in Step 1.5. This is not optional.

**Decision tree if you're unsure which agent to use:**
```
Is it frontend code (.tsx, .ts, React)? → frontend-excellence:react-specialist
Is it backend code (.py, FastAPI)? → backend-security:backend-expert
Is it tests? → dev-accelerator:test-automator
Is it infrastructure (Docker, CI/CD)? → infra-pipeline:infra-architect
Multiple domains? → SPAWN MULTIPLE AGENTS IN PARALLEL
Still unsure? → general-purpose (BUT STILL SPAWN IT)
```

**Task Invocation Templates:**

**Single Agent (single domain):**

Use the agent selected in Step 1.5 with the Task tool.

**For first iteration (iteration_01):**

```typescript
// Example Task call:
Task({
  subagent_type: "{selected_agent}",  // From Step 1.5
  description: "Implement {scope} iteration_01",
  prompt: `Execute iteration work for {scope}/{iteration}:

1. Read iteration_plan.md at .agent_process/work/{scope}/iteration_plan.md
2. Review acceptance criteria (LOCKED - these are your requirements)
3. Follow the Technical Assessment implementation guidance
4. Implement all required code changes
5. Add or update automated tests for changes
6. Perform manual spot checks to confirm behavior

IMPORTANT CONTEXT:
- Scope: {scope}
- Iteration: {iteration}
- Files in scope: [list from iteration_plan.md]
- Validation will run automatically via hook after you complete

Work directly on the code - do NOT launch additional subagents.
Report completion status when done, including:
- What was implemented
- What tests were added/updated
- Any issues encountered
`
})
```

**For sub-iterations (iteration_01_a/b/c):**

```typescript
// Example Task call:
Task({
  subagent_type: "{selected_agent}",  // From Step 1.5
  description: "Fix issues for {scope} {iteration}",
  prompt: `Execute iteration work for {scope}/{iteration}:

1. Read iteration_plan.md at .agent_process/work/{scope}/iteration_plan.md
2. Read {iteration}/results.md for the 1-3 specific fixes required
3. Read {parent_iteration}/results.md to see what was already tried
4. Focus ONLY on addressing the specific fixes from orchestrator review
5. Build on what already works - don't break working parts
6. Add or update tests for the fixes
7. Perform manual spot checks to confirm fixes work

IMPORTANT CONTEXT:
- Scope: {scope}
- Iteration: {iteration} (sub-iteration fixing specific issues)
- Previous iteration: {parent_iteration}
- This is attempt {X} of maximum 3 sub-iterations
- Validation will run automatically via hook after you complete

Work directly on the code - do NOT launch additional subagents.
Report completion status when done, including:
- Which specific fixes were addressed
- What was changed to fix them
- Any remaining issues
`
})
```

**Multiple Agents (multi-domain scope):**

When the scope spans multiple domains, spawn all agents in a SINGLE response with multiple Task calls. This runs them in parallel for efficiency.

```typescript
// Example: Frontend + Backend + Tests scope
// Send ALL THREE Task calls in ONE response:

Task({
  subagent_type: "frontend-excellence:react-specialist",
  description: "Implement frontend for {scope}",
  prompt: `Execute FRONTEND changes for {scope}/{iteration}:

1. Read iteration_plan.md at .agent_process/work/{scope}/iteration_plan.md
2. Focus ONLY on frontend files: [list frontend files from scope]
3. Implement React component changes per acceptance criteria
4. Add/update Jest tests for frontend changes

Files you are responsible for:
- frontend/src/components/...
- frontend/src/hooks/...

Do NOT touch backend or E2E test files - other agents handle those.
Report what you implemented when done.
`
})

Task({
  subagent_type: "backend-security:backend-expert",
  description: "Implement backend for {scope}",
  prompt: `Execute BACKEND changes for {scope}/{iteration}:

1. Read iteration_plan.md at .agent_process/work/{scope}/iteration_plan.md
2. Focus ONLY on backend files: [list backend files from scope]
3. Implement API/service changes per acceptance criteria
4. Add/update pytest tests for backend changes

Files you are responsible for:
- backend/app/api/...
- backend/app/services/...

Do NOT touch frontend or E2E test files - other agents handle those.
Report what you implemented when done.
`
})

Task({
  subagent_type: "dev-accelerator:test-automator",
  description: "Implement E2E tests for {scope}",
  prompt: `Execute E2E TEST changes for {scope}/{iteration}:

1. Read iteration_plan.md at .agent_process/work/{scope}/iteration_plan.md
2. Focus ONLY on E2E test files: [list test files from scope]
3. Write/update Playwright E2E tests per acceptance criteria
4. Ensure tests cover the integration between frontend and backend

Files you are responsible for:
- tests/e2e/...

Do NOT touch frontend or backend implementation files - other agents handle those.
Report what tests you added/updated when done.
`
})
```

⚠️ **CRITICAL for parallel agents:**
- Send ALL Task calls in ONE response (not sequential responses)
- Each agent gets a clearly scoped subset of files
- Agents should NOT overlap in file responsibility
- Wait for ALL agents to complete before proceeding to Step 3

**Agent-Specific Context Enhancements:**

When using specialized agents, add relevant context to the prompt:

- **frontend-excellence:react-specialist**: Include React patterns, Lexical framework rules (see `.local_docs/lexical/`), performance requirements
- **frontend-excellence:component-architect**: Include design system tokens, component API patterns, accessibility requirements
- **frontend-excellence:css-expert**: Include Tailwind config, design tokens, responsive breakpoints, WCAG requirements
- **frontend-excellence:state-manager**: Include current state structure, data flow requirements, persistence needs
- **backend-security:backend-expert**: Include database schema requirements, RLS policies, async patterns
- **backend-security:api-architect**: Include API contracts, authentication requirements, rate limiting needs
- **dev-accelerator:test-automator**: Include test coverage requirements, testing patterns, fixtures/mocks needed
- **dev-accelerator:debugger**: Include error logs, reproduction steps, expected vs actual behavior
- **infra-pipeline:infra-architect**: Include cloud provider, scaling requirements, cost constraints
- **infra-pipeline:cicd-engineer**: Include deployment targets, test stages, approval gates

**Why use Task tool:**
- The SubagentStop hook fires automatically when Task completes
- Hook runs the scoped validation script (`.agent_process/scripts/after_edit/validate-{scope}.sh`)
- Provides immediate feedback on lint/test issues
- Specialized agents bring domain expertise to implementation

---

## Step 3: Validate Your Work

**After Task completes, the hook has already run.**

**Where to find hook output:**
The SubagentStop hook runs automatically and its output appears in your terminal/chat immediately after the Task agent completes. Look for lines starting with:
```
[hook_after_edit] Running scoped validation for {scope}/{iteration}
[hook_after_edit] Running validate-{scope}.sh
```

**Check hook results:**
- **PASS**: Hook exits with code 0, you'll see `[hook_after_edit] Complete`
- **FAIL**: Hook exits non-zero, you'll see error output from ESLint or Jest

**If hook FAILED (exit non-zero):**
1. Scroll up in terminal to see the validation errors
2. Look for ESLint errors or test failures in the hook output
3. Fix the issues (lint errors, test failures)
4. Re-run the Task (maximum 3 attempts)
5. Each retry will re-trigger the hook
6. If still failing after 3 attempts, STOP and report blockers

**If hook PASSED (exit 0):**
- Proceed to Step 4 to capture the output

**Do NOT proceed until hook validation passes.**

---

## Step 4: Run Full Validation Commands

**Create test-output.txt with header:**
```bash
cat > .agent_process/work/{scope}/{iteration}/test-output.txt <<EOF
# Validation Results - {scope}/{iteration}

## Summary
- Scoped validation (hook): PENDING
- Manual verification: PENDING

## Detailed Logs

EOF
```

**Capture scoped validation results (no copy/paste required):**

If you still have the hook output visible, you can re-run the scoped validator and tee the logs directly into `test-output.txt`:

```bash
bash .agent_process/scripts/after_edit/validate-{scope}.sh {scope} {iteration} | tee -a .agent_process/work/{scope}/{iteration}/test-output.txt
```

Then append a marker so reviewers know what the section contains:

```bash
cat >> .agent_process/work/{scope}/{iteration}/test-output.txt <<'EOF'

=== Scoped Validation ($(date -Iseconds)) ===
# Output above was captured via tee
EOF
```

Finally, update the summary line using a portable script:

```bash
python - <<'PY'
from pathlib import Path
path = Path(".agent_process/work/{scope}/{iteration}/test-output.txt")
text = path.read_text()
text = text.replace("Scoped validation (hook): PENDING", "Scoped validation (hook): PASS (hook)", 1)
path.write_text(text)
PY
```

> If you cannot re-run the validator (e.g., expensive Playwright suite), capture the original hook output manually and paste it into the detailed logs instead.

**Run manual verification (if needed):**

If the iteration_plan.md specifies manual QA:
- Perform the manual tests
- Document findings in test-output.txt
- Update summary line

**Optional: Run broader validation commands**

The iteration_plan.md may list additional validation:
- Full test suite (if different from scoped tests)
- E2E tests for specific scenarios
- Visual checks

Run these if specified, append output to test-output.txt.

**E2E Test Execution (IMPORTANT):**

E2E tests run automatically via the validation script using Playwright's `webServer` feature. The servers (frontend + backend) are auto-started by Playwright - you do NOT need to start them manually.

Standard E2E command in validation scripts:
```bash
npx playwright test tests/e2e/features/your-spec.ts --config=playwright.e2e.config.ts
```

This command:
1. Starts backend on port 8001 (if not already running)
2. Starts frontend on port 5175 (if not already running)
3. Runs the E2E tests
4. Reports results

If you see server startup timeout errors, troubleshoot per the "E2E tests and server startup" section in Troubleshooting below.

**Note:** Some older validators may skip Playwright or only print instructions. Always check the validation script content. Modern validators should include the full Playwright command with `--config=playwright.e2e.config.ts`.

---

## Step 5: Document Results

**Call /ap_iteration_results to create results.md:**
```
/ap_iteration_results {scope} {iteration}
```

This command will:
- Read test-output.txt
- Generate results.md with structured summary
- List changed files
- Document validation status
- Note any known issues

**Do NOT create results.md manually** - let /ap_iteration_results do it.

---

## Step 6: Report Completion

**Provide summary to user:**

```markdown
## Iteration Complete: {scope}/{iteration}

**Acceptance Criteria Status:**
- [ ] Criterion 1: [Met/Not Met - brief note]
- [ ] Criterion 2: [Met/Not Met - brief note]
- [ ] Criterion 3: [Met/Not Met - brief note]

**Validation Status:**
- Scoped validation (hook): [PASS/FAIL]
- Manual verification: [PASS/FAIL/SKIPPED]

**Files Changed:** {count} files

**Known Issues:**
[List any issues discovered or criteria not met]

**Artifacts Created:**
- `.agent_process/work/{scope}/{iteration}/results.md`
- `.agent_process/work/{scope}/{iteration}/test-output.txt`

**Ready for Review:** [YES/NO - explain if NO]
```

**If validation failed or criteria not met:**
- Clearly state what's incomplete
- List specific blockers
- Do NOT claim iteration is ready for review

**If everything passed:**
- State that iteration is ready for orchestrator review
- Summarize what was accomplished

---

## Important Rules

**Scope boundaries:**
- Implement ONLY the locked acceptance criteria
- Do NOT expand scope based on "nice to have" findings
- New issues → backlog, not this iteration

**Validation enforcement:**
- Hook must PASS before proceeding to full validation
- Maximum 3 retry attempts on hook failures
- Stop and report if unable to pass validation

**No scope creep:**
- Acceptance criteria are FROZEN
- Cannot add new requirements mid-iteration
- Follow Technical Assessment guidance exactly

**Iteration budget:**
- This is attempt {iteration} (e.g., iteration_01, iteration_01_a)
- Maximum 3 sub-iterations (a/b/c) before escalation
- If you're on iteration_01_c, this is the final attempt

---

## Troubleshooting

**Hook keeps failing:**
- Review validation script at `.agent_process/scripts/after_edit/validate-{scope}.sh`
- Check that you're only modifying files in scope
- Verify tests are properly written and passing
- Ensure required tooling is installed (e.g., run `npx playwright install --with-deps firefox` if browser installs are missing)
- After 3 attempts, stop and report blocker

**E2E tests and server startup:**

⚠️ **IMPORTANT**: E2E tests DO NOT require manually starting servers!

The project's Playwright configuration includes a `webServer` section that automatically starts both frontend and backend servers before running tests. Specifically:

- `playwright.e2e.config.ts` starts:
  - Frontend: `npm run dev` on port 5175
  - Backend: `uvicorn app.main:app` on port 8001

- Key config options:
  - `reuseExistingServer: true` - Won't start new servers if they're already running
  - `timeout: 120000` - Allows 2 minutes for servers to start

**Correct behavior:**
```bash
# This command handles everything - server startup, test execution, teardown
npx playwright test tests/e2e/features/your-spec.ts --config=playwright.e2e.config.ts
```

**Do NOT:**
- Report that E2E tests couldn't run because "servers weren't running"
- Skip E2E tests claiming they "require a running dev server"
- Manually start servers before running validation scripts

**If E2E tests fail to start servers:**
1. Check if ports 5175/8001 are in use by stale processes: `lsof -i :5175 -i :8001`
2. Kill stale processes if needed: `pkill -f vite && pkill -f uvicorn`
3. Verify backend dependencies: `cd backend && pip install -r requirements.txt`
4. Verify Playwright browsers: `npx playwright install --with-deps`

**Can't meet acceptance criteria:**
- Document specifically what's blocking progress
- Note in results.md "Known Issues" section
- Mark iteration as NOT ready for review
- Orchestrator will decide: ITERATE/BLOCK/PIVOT

**Discovered new issues:**
- Document in results.md "Known Issues" section
- Do NOT add to acceptance criteria
- These become backlog items for future scopes

---

## Success Checklist

Before reporting completion, verify:

- [ ] All acceptance criteria addressed (met or documented why not)
- [ ] Tests written/updated for changes
- [ ] Scoped validation (hook) PASSED
- [ ] test-output.txt contains validation results
- [ ] results.md created via /ap_iteration_results
- [ ] Only files in scope were modified
- [ ] No scope creep beyond locked criteria
- [ ] Clear statement of ready/not-ready for review

---

**Remember:** This is implementation only. Orchestrator review comes next.
