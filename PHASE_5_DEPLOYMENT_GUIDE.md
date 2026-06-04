# PHASE 5 DEPLOYMENT GUIDE

## Quick Reference for Deployment Team

### Pre-Deployment Checklist
- [ ] All code reviewed and approved
- [ ] Staging environment tested
- [ ] Database backup completed
- [ ] Rollback plan documented
- [ ] Team notified of deployment window

---

## Deployment Steps

### 1. Backend Deployment (azaman-backend-main)

```bash
# Navigate to backend directory
cd azaman-backend-main

# Pull latest changes
git pull origin main

# Install dependencies (if needed)
npm install

# Apply schema changes
node infra/install-susu-overlay.js
# Expected output: "[install-susu-overlay] done: 68 ok, 0 failed"

# Validate schema
npx prisma validate
# Expected output: "The schema at prisma/schema.prisma is valid 🚀"

# Generate Prisma client
npx prisma generate

# Restart the server
pm2 restart azaman-backend
# OR: npm run restart
# OR: systemctl restart azaman-backend

# Verify server is running
curl http://localhost:3000/health
```

**Verification**:
```bash
# Check if susuProfitPct is in settings
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://localhost:3000/api/admin/settings | jq '.settings.susuProfitPct'
# Expected output: 0.03
```

---

### 2. Flutter Deployment (azaman-frontend-main)

```bash
# Navigate to Flutter directory
cd azaman-frontend-main

# Pull latest changes
git pull origin main

# Clean build
flutter clean
flutter pub get

# Build Android APK
flutter build apk --release
# Output: build/app/outputs/flutter-apk/app-release.apk

# Build iOS (if applicable)
flutter build ios --release
# Output: build/ios/iphoneos/Runner.app

# Upload to Play Store / App Store
# (Follow your standard app deployment process)
```

**Verification**:
- Open app and navigate to Susu Config screen
- Verify fee breakdown displays correctly
- Test with different contribution amounts
- Confirm calculations match: `fee = FLOOR(total × 0.03 × 100) / 100`

---

### 3. Admin Portal Deployment (admin_web_portal)

```bash
# Navigate to admin portal directory
cd admin_web_portal

# Pull latest changes
git pull origin main

# Install dependencies
npm install

# Build production bundle
npm run build
# Output: dist/ directory

# Deploy to hosting (example: Vercel)
vercel --prod
# OR: npm run deploy
# OR: Copy dist/ to your web server

# Verify deployment
curl https://admin.azaman.com/health
```

**Verification**:
- Log in to admin portal
- Navigate to Config page
- Verify "Susu Platform Fee" section is visible
- Test updating the fee percentage
- Confirm changes are saved and reflected

---

## Post-Deployment Verification

### 1. Database Verification
```sql
-- Check GlobalSettings table
SELECT "susuProfitPct" FROM "GlobalSettings" WHERE id = 1;
-- Expected: 0.03

-- Check SusuCycle schema
\d "SusuCycle"
-- Should include: feeUsdc column (Decimal?)

-- Check TransactionType enum
SELECT unnest(enum_range(NULL::"TransactionType"));
-- Should include: SUSU_PROFIT

-- Check ProfitSource enum
SELECT unnest(enum_range(NULL::"ProfitSource"));
-- Should include: SUSU_FEE
```

### 2. API Verification
```bash
# Test GET settings
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://localhost:3000/api/admin/settings

# Test UPDATE settings
curl -X PUT \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"susuProfitPct": 0.05}' \
  http://localhost:3000/api/admin/settings

# Verify update
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://localhost:3000/api/admin/settings | jq '.settings.susuProfitPct'
# Expected: 0.05

# Reset to default
curl -X PUT \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"susuProfitPct": 0.03}' \
  http://localhost:3000/api/admin/settings
```

### 3. End-to-End Test
1. **Create Test Susu** (via Flutter app):
   - Create group with 5 members
   - Set contribution: $20
   - Verify fee breakdown shows:
     * Total Pool: $100.00
     * Azaman Fee (3.0%): -$3.00
     * Actual Take-Home Payout: $97.00

2. **Process Test Cycle** (wait for collection date or manually trigger):
   ```bash
   # Manually trigger cycle processing (if needed)
   curl -X POST \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     http://localhost:3000/api/admin/susu/process-cycle/<CYCLE_ID>
   ```

3. **Verify Results**:
   ```sql
   -- Check cycle record
   SELECT "id", "payoutAmount", "feeUsdc", "status"
   FROM "SusuCycle"
   WHERE "id" = <CYCLE_ID>;
   -- Expected: payoutAmount = 97.00, feeUsdc = 3.00

   -- Check profit log
   SELECT * FROM "AdminProfitLog"
   WHERE "source" = 'SUSU_FEE'
   ORDER BY "createdAt" DESC
   LIMIT 1;
   -- Should show: amountUsdc = 3.00, metadata includes cycleId

   -- Check transaction history
   SELECT * FROM "TransactionHistory"
   WHERE "type" = 'SUSU_PROFIT'
   ORDER BY "createdAt" DESC
   LIMIT 1;
   -- Should show: amountUsdc = 3.00, status = COMPLETED
   ```

---

## Rollback Plan

### If Issues Arise:

#### Backend Rollback
```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Restart server
pm2 restart azaman-backend

# If schema changes cause issues:
# 1. Restore database from backup
# 2. Revert code changes
# 3. Restart server
```

#### Flutter Rollback
```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Rebuild and redeploy
flutter build apk --release
# Upload previous version to stores
```

#### Admin Portal Rollback
```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Rebuild and redeploy
npm run build
vercel --prod
```

---

## Monitoring

### Key Metrics to Watch (First 24 Hours)

1. **Error Rates**:
   - Monitor backend logs for errors in `processCycle()`
   - Check for failed `AdminProfitLog` insertions
   - Watch for `SUSU_PROFIT` transaction failures

2. **Database Performance**:
   - Monitor query performance on `GlobalSettings` table
   - Check for slow queries on `SusuCycle` updates
   - Verify indexes are being used

3. **User Experience**:
   - Monitor Flutter crash reports
   - Check for UI rendering issues on Config screen
   - Verify fee calculations are accurate

4. **Financial Accuracy**:
   - Audit first 10 cycle payouts manually
   - Verify fee amounts match expected calculations
   - Check `AdminProfitLog` totals against cycle fees

### Monitoring Queries
```sql
-- Total Susu fees collected today
SELECT SUM("amountUsdc") as "totalFees"
FROM "AdminProfitLog"
WHERE "source" = 'SUSU_FEE'
  AND "createdAt" >= CURRENT_DATE;

-- Average fee per cycle
SELECT AVG("feeUsdc") as "avgFee"
FROM "SusuCycle"
WHERE "feeUsdc" IS NOT NULL;

-- Cycles processed today
SELECT COUNT(*) as "cyclesProcessed"
FROM "SusuCycle"
WHERE "status" IN ('PAID_OUT', 'DEFAULTED')
  AND "paidOutAt" >= CURRENT_DATE;
```

---

## Support Contacts

- **Backend Issues**: Check `services/susuService.js` line ~350-450
- **Flutter Issues**: Check `lib/screens/susu/susu_config_screen.dart`
- **Admin Portal Issues**: Check `src/pages/Config.jsx`
- **Database Issues**: Run `node validate-phase5.js` for diagnostics

---

## Success Criteria

Deployment is considered successful when:
- ✅ All validation checks pass (`node validate-phase5.js`)
- ✅ Backend health check returns 200
- ✅ Admin portal loads without errors
- ✅ Flutter app displays fee breakdown correctly
- ✅ Test cycle processes with correct fee deduction
- ✅ AdminProfitLog entries are created
- ✅ No increase in error rates
- ✅ User feedback is positive

---

## Timeline

**Estimated Deployment Time**: 30-45 minutes
- Backend: 10-15 minutes
- Flutter: 15-20 minutes (build time)
- Admin Portal: 5-10 minutes

**Recommended Deployment Window**: Low-traffic period (e.g., 2-4 AM local time)

---

## Final Notes

- This is a **non-breaking change** - existing Susus continue to work
- Fee only applies to **new cycles** processed after deployment
- Users will see fee breakdown on **next Susu initiation**
- Admin can adjust fee immediately via portal (no code changes needed)
- All changes are **fully audited** and reversible

**Questions?** Review `PHASE_5_SUMMARY.md` for detailed implementation notes.
