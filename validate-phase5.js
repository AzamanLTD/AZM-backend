#!/usr/bin/env node
// validate-phase5.js
// Quick validation script to verify Phase 5 implementation

const fs = require('fs');
const path = require('path');

console.log('🔍 PHASE 5 VALIDATION SCRIPT\n');

const checks = [];

// 1. Check schema.prisma for new fields
console.log('1️⃣  Checking schema.prisma...');
const schemaPath = path.join(__dirname, 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');

checks.push({
  name: 'GlobalSettings.susuProfitPct',
  pass: schema.includes('susuProfitPct') && schema.includes('Decimal') && schema.includes('@default(0.03)'),
});

checks.push({
  name: 'SusuCycle.feeUsdc',
  pass: schema.includes('feeUsdc') && schema.includes('Decimal?'),
});

checks.push({
  name: 'TransactionType.SUSU_PROFIT',
  pass: schema.includes('SUSU_PROFIT'),
});

checks.push({
  name: 'ProfitSource.SUSU_FEE',
  pass: schema.includes('SUSU_FEE'),
});

// 2. Check susuService.js for profit skim logic
console.log('2️⃣  Checking susuService.js...');
const servicePath = path.join(__dirname, 'services', 'susuService.js');
const service = fs.readFileSync(servicePath, 'utf8');

checks.push({
  name: 'Profit skim logic',
  pass: service.includes('susuProfitPct') && service.includes('feeUsdc') && service.includes('netPayout'),
});

checks.push({
  name: 'AdminProfitLog creation',
  pass: service.includes('adminProfitLog.create') && service.includes('SUSU_FEE'),
});

checks.push({
  name: 'SUSU_PROFIT transaction',
  pass: service.includes('type: \'SUSU_PROFIT\''),
});

// 3. Check adminSettingsController.js
console.log('3️⃣  Checking adminSettingsController.js...');
const controllerPath = path.join(__dirname, 'controllers', 'adminSettingsController.js');
const controller = fs.readFileSync(controllerPath, 'utf8');

checks.push({
  name: 'susuProfitPct in GET response',
  pass: controller.includes('susuProfitPct: Number(settings.susuProfitPct)'),
});

checks.push({
  name: 'susuProfitPct in ALLOWED_FIELDS',
  pass: controller.includes('\'susuProfitPct\'') && controller.includes('ALLOWED_FIELDS'),
});

checks.push({
  name: 'susuProfitPct validation',
  pass: controller.includes('susuProfitPct') && controller.includes('pctFields'),
});

// 4. Check Flutter susu_config_screen.dart
console.log('4️⃣  Checking Flutter susu_config_screen.dart...');
const flutterPath = path.join(__dirname, '..', 'azaman-frontend-main', 'lib', 'screens', 'susu', 'susu_config_screen.dart');
if (fs.existsSync(flutterPath)) {
  const flutter = fs.readFileSync(flutterPath, 'utf8');
  
  checks.push({
    name: 'Fee breakdown UI',
    pass: flutter.includes('PAYOUT BREAKDOWN') && flutter.includes('Azaman Fee'),
  });
  
  checks.push({
    name: 'Fee calculation methods',
    pass: flutter.includes('_calculateTotalPool') && flutter.includes('_calculateFee') && flutter.includes('_calculateNetPayout'),
  });
  
  checks.push({
    name: 'Platform fee constant',
    pass: flutter.includes('_platformFeePct') && flutter.includes('0.03'),
  });
} else {
  checks.push({
    name: 'Flutter file exists',
    pass: false,
    note: 'File not found at expected path',
  });
}

// 5. Check Admin Portal Config.jsx
console.log('5️⃣  Checking Admin Portal Config.jsx...');
const adminPath = path.join(__dirname, '..', 'admin_web_portal', 'src', 'pages', 'Config.jsx');
if (fs.existsSync(adminPath)) {
  const admin = fs.readFileSync(adminPath, 'utf8');
  
  checks.push({
    name: 'Susu fee section',
    pass: admin.includes('Susu Platform Fee') && admin.includes('DollarSign'),
  });
  
  checks.push({
    name: 'Global settings query',
    pass: admin.includes('global-settings') && admin.includes('susuProfitPct'),
  });
  
  checks.push({
    name: 'Update mutation',
    pass: admin.includes('updateGs') && admin.includes('api.settings.update'),
  });
} else {
  checks.push({
    name: 'Admin Portal file exists',
    pass: false,
    note: 'File not found at expected path',
  });
}

// Print results
console.log('\n📊 VALIDATION RESULTS\n');
console.log('═'.repeat(60));

let passed = 0;
let failed = 0;

checks.forEach((check, idx) => {
  const status = check.pass ? '✅' : '❌';
  const note = check.note ? ` (${check.note})` : '';
  console.log(`${status} ${check.name}${note}`);
  
  if (check.pass) passed++;
  else failed++;
});

console.log('═'.repeat(60));
console.log(`\n📈 Summary: ${passed}/${checks.length} checks passed`);

if (failed === 0) {
  console.log('\n🎉 ALL CHECKS PASSED! Phase 5 implementation is complete.\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failed} check(s) failed. Please review the implementation.\n`);
  process.exit(1);
}
