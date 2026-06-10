import jsdoc from 'eslint-plugin-jsdoc';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    plugins: { jsdoc },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        Blob: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        Document: 'readonly',
        DOMException: 'readonly',
        Event: 'readonly',
        FileReader: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly',
        IDBKeyRange: 'readonly',
        indexedDB: 'readonly',
        localStorage: 'readonly',
        MediaRecorder: 'readonly',
        navigator: 'readonly',
        OffscreenCanvas: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        URL: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > ClassDeclaration',
            'ClassDeclaration MethodDefinition',
          ],
        },
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/check-tag-names': 'error',
    },
  },
];
