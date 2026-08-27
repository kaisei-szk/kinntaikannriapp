import readline from 'node:readline';
import bcrypt from 'bcryptjs';

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    // Minimal hidden-input prompt (no external dependency).
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(value);
      } else if (char === '') {
        process.exit(1);
      } else if (char === '') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

const password = await prompt('管理画面の新しいパスワードを入力してください: ', { hidden: true });
if (!password) {
  console.error('パスワードが入力されませんでした。');
  process.exit(1);
}
const confirm = await prompt('確認のためもう一度入力してください: ', { hidden: true });
if (password !== confirm) {
  console.error('入力が一致しませんでした。');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\n以下の行を .env ファイルの ADMIN_PASSWORD_HASH に設定してください:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
