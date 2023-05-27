const { CloudClient } = require('./dist/index.js');

const companionClient = new CloudClient(
    '6de990a5-f45d-55c8-80f4-3bc3c393525d',
    // 'd84d2efe-8943-580c-8a8e-c98742043fa9',
);

(async () => {
    companionClient.on('state', (state, _message) => {
        console.log('state', state, _message);
    });

    companionClient.on('updateAll', () => {
        console.log('updateAll');
    });

    companionClient.on('log', (level, message) => {
        console.log('log', 'LOG:', level, message);
    });

    console.log('init');
    await companionClient.init();
    console.log('connect');
    companionClient.connect();

})();
