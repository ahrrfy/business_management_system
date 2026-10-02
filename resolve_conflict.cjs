const fs = require('fs');
let content = fs.readFileSync('server/services/__tests__/moneyTrailDelivery.test.ts', 'utf8');
content = content.replace(/<<<<<<< HEAD\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> origin\/main/g, '$1');
fs.writeFileSync('server/services/__tests__/moneyTrailDelivery.test.ts', content, 'utf8');
console.log('Resolved conflict in moneyTrailDelivery.test.ts');
