import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  publishFlowDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import { resetMemoryCacheForTests } from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { webApp } from '../src/server/webApp.ts';
import type { NalasStore, ProductionSummary } from '../src/shared/types.ts';

async function withTempStore(
  setup: (store: NalasStore) => void | Promise<void>,
  run: (tmpDir: string) => Promise<void>
) {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-nexo-menu-'));
  resetMemoryCacheForTests();
  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    const store = createInitialStore();
    await setup(store);
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(store, null, 2),
      'utf8'
    );
    resetMemoryCacheForTests();
    await run(tmpDir);
  } finally {
    resetMemoryCacheForTests();
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('NEXO publica menú con Nala v2 + Opting + VOLVÉ + BenefitOS + GIRO sin desactivar opciones sin flujo; cada destino responde correctamente', async () => {
  let nalaV2Id = '';
  let optingPubId = '';
  let prodConnId = '';

  await withTempStore(
    (store) => {
      const nexo = store.businesses.find((b) => b.id === 'biz_nexo')!;
      const optingFlow = store.flowVersions.find((f) => f.id === nexo.activeFlowVersionId)!;
      saveFlowDraft(
        store,
        'biz_nexo',
        'user_michael',
        structuredClone(optingFlow.steps),
        structuredClone(optingFlow.outOfScriptRules),
        'Opting',
        undefined,
        'opting'
      );
      const { published: optingPub } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'opting');
      optingPubId = optingPub.id;

      // Publicar Nala v1 y luego Nala v2
      saveFlowDraft(
        store,
        'biz_nexo',
        'user_michael',
        [
          {
            id: 'nala_1',
            title: '1. Consulta Nala v1',
            type: 'texto',
            prompt: 'NALA_V1_NO_USAR',
            targetField: 'consulta',
            required: true,
            nextStepId: 'nala_cierre',
          },
          {
            id: 'nala_cierre',
            title: '2. Cierre',
            type: 'cierre',
            prompt: 'Gracias v1',
            required: false,
            nextStepId: null,
          },
        ],
        [],
        'Nala',
        undefined,
        'nala'
      );
      publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');

      saveFlowDraft(
        store,
        'biz_nexo',
        'user_michael',
        [
          {
            id: 'nala_1',
            title: '1. Consulta inicial Nala',
            type: 'texto',
            prompt: 'NALA_V2_PUBLICADA_EXACTA: Contanos qué necesitás automatizar con Nala.',
            targetField: 'consulta',
            required: true,
            nextStepId: 'nala_cierre',
          },
          {
            id: 'nala_cierre',
            title: '2. Cierre Nala',
            type: 'cierre',
            prompt: 'Gracias por escribirnos sobre Nala.',
            required: false,
            nextStepId: null,
          },
        ],
        [],
        'Nala',
        undefined,
        'nala'
      );
      const { published: nalaV2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');
      nalaV2Id = nalaV2.id;

      // Estado inicial publicado ANTES de editar: solo Opting activo (simula estado previo antes de publicar Nala + 4 opciones)
      nexo.entryConfig = {
        enabled: true,
        greetingPrompt: 'SALUDO_PREVIO_SIN_NALA',
        unconfiguredProductPrompt:
          'Podemos derivar tu consulta sobre {{producto}} al equipo de NEXO. ¿Querés solicitar atención humana?',
      };
      nexo.products = [
        {
          id: 'prod_nexo_opting',
          name: 'Opting',
          optionLabel: 'Opting',
          referencePrefix: 'opting',
          targetType: 'flow',
          flowKey: 'opting',
          flowVersionId: optingPub.id,
          active: true,
        },
      ];

      const conn = store.channelConnections.find(
        (c) => c.businessId === 'biz_nexo' && c.environment === 'produccion'
      )!;
      prodConnId = conn.id;
    },
    async () => {
      const configuredProducts = [
        {
          id: 'prod_nexo_opting',
          name: 'Opting',
          optionLabel: 'Opting',
          referencePrefix: 'opting',
          targetType: 'flow',
          flowKey: 'opting',
          flowVersionId: optingPubId,
          active: true,
        },
        {
          id: 'prod_nexo_volve',
          name: 'VOLVÉ',
          optionLabel: 'VOLVÉ',
          referencePrefix: 'volve',
          targetType: 'flow',
          active: true,
        },
        {
          id: 'prod_nexo_benefitos',
          name: 'BenefitOS',
          optionLabel: 'BenefitOS',
          referencePrefix: 'benefitos',
          targetType: 'flow',
          active: true,
        },
        {
          id: 'prod_nexo_giro',
          name: 'GIRO',
          optionLabel: 'GIRO',
          referencePrefix: 'giro',
          targetType: 'flow',
          active: true,
        },
        {
          id: 'prod_nexo_nala',
          name: 'Nala',
          optionLabel: 'Nala',
          referencePrefix: 'nala',
          targetType: 'flow',
          flowKey: 'nala',
          flowVersionId: nalaV2Id,
          active: true,
        },
      ];

      const entryConfigPayload = {
        enabled: true,
        greetingPrompt:
          '¡Hola! Gracias por escribir a NEXO Technologies. ¿Sobre cuál de nuestras soluciones querés conversar?',
        unconfiguredProductPrompt:
          'Podemos derivar tu consulta sobre {{producto}} al equipo de NEXO. ¿Querés solicitar atención humana?',
      };

      // 1. Guardar borrador NO publica automáticamente
      const draftRes = await webApp.request('http://localhost/api/entry-menu/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ entryConfig: entryConfigPayload, products: configuredProducts }),
      });
      assert.equal(draftRes.status, 200);

      const summaryBeforePublishRes = await webApp.request(
        'http://localhost/api/assistant/production-summary',
        { headers: { 'x-nalas-business-id': 'biz_nexo' } }
      );
      assert.equal(summaryBeforePublishRes.status, 200);
      const summaryBefore = (await summaryBeforePublishRes.json()) as ProductionSummary;
      assert.equal(summaryBefore.entryMenu.greetingPrompt, 'SALUDO_PREVIO_SIN_NALA');
      assert.equal(summaryBefore.entryMenu.hasPendingDraft, true);
      assert.equal(summaryBefore.entryMenu.options.some((o) => o.name === 'Nala'), false);

      // 2. Publicar saludo y menú con las 5 opciones activas (sin exigir desactivar VOLVÉ, BenefitOS ni GIRO)
      const pubRes = await webApp.request('http://localhost/api/entry-menu/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ entryConfig: entryConfigPayload, products: configuredProducts }),
      });
      assert.equal(pubRes.status, 200);

      const summaryAfterRes = await webApp.request(
        'http://localhost/api/assistant/production-summary',
        { headers: { 'x-nalas-business-id': 'biz_nexo' } }
      );
      assert.equal(summaryAfterRes.status, 200);
      const summaryAfter = (await summaryAfterRes.json()) as ProductionSummary;
      assert.deepEqual(summaryAfter.entryMenu.validationErrors, []);
      assert.equal(summaryAfter.entryMenu.hasPendingDraft, false);
      assert.deepEqual(
        summaryAfter.entryMenu.options.filter((o) => o.active).map((o) => o.optionLabel),
        ['Opting', 'VOLVÉ', 'BenefitOS', 'GIRO', 'Nala']
      );
      const nalaOptSummary = summaryAfter.entryMenu.options.find((o) => o.name === 'Nala')!;
      assert.equal(nalaOptSummary.destinationStatus, 'valida');
      assert.equal(nalaOptSummary.targetFlowId, nalaV2Id);
      assert.equal(nalaOptSummary.targetFlowVersionNumber, 2);

      for (const unconfiguredName of ['VOLVÉ', 'BenefitOS', 'GIRO']) {
        const opt = summaryAfter.entryMenu.options.find((o) => o.name === unconfiguredName)!;
        assert.equal(opt.active, true);
        assert.equal(opt.destinationStatus, 'sin_publicar');
      }

      // 3. Cliente A inicia interacción: recibe menú con las 5 opciones en orden y elige Nala -> abre Nala v2
      const startARes = await webApp.request('http://localhost/api/simulator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          connectionId: prodConnId,
          externalUserId: '50680110001',
          contactPhone: '+50680110001',
        }),
      });
      assert.equal(startARes.status, 200);
      const startA = (await startARes.json()) as { conversation: { id: string } };

      const holaARes = await webApp.request(
        `http://localhost/api/conversations/${startA.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({ text: 'Hola', providerEventId: 'nexo_menu_1' }),
        }
      );
      assert.equal(holaARes.status, 200);
      const holaAJson = (await holaARes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string; options?: Array<{ id: string; label: string }> };
      };
      assert.equal(holaAJson.botReplied, true);
      assert.deepEqual(
        holaAJson.outgoingMessage?.options?.map((o) => o.label),
        ['Opting', 'VOLVÉ', 'BenefitOS', 'GIRO', 'Nala']
      );

      const pickNalaRes = await webApp.request(
        `http://localhost/api/conversations/${startA.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'Nala',
            selectedOptionId: 'prod:prod_nexo_nala',
            providerEventId: 'nexo_menu_2',
          }),
        }
      );
      assert.equal(pickNalaRes.status, 200);
      const pickNalaJson = (await pickNalaRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string };
      };
      assert.equal(pickNalaJson.botReplied, true);
      assert.match(pickNalaJson.outgoingMessage?.text ?? '', /NALA_V2_PUBLICADA_EXACTA/);
      assert.doesNotMatch(pickNalaJson.outgoingMessage?.text ?? '', /NALA_V1_NO_USAR/);

      // 4. Cliente B elige VOLVÉ (sin conversación): recibe alternativa configurable de atención humana, NO queda bloqueado y NO corre Opting
      const startBRes = await webApp.request('http://localhost/api/simulator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          connectionId: prodConnId,
          externalUserId: '50680110002',
          contactPhone: '+50680110002',
        }),
      });
      assert.equal(startBRes.status, 200);
      const startB = (await startBRes.json()) as { conversation: { id: string } };

      await webApp.request(`http://localhost/api/conversations/${startB.conversation.id}/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: 'Hola', providerEventId: 'nexo_menu_b1' }),
      });

      const pickVolveRes = await webApp.request(
        `http://localhost/api/conversations/${startB.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'VOLVÉ',
            selectedOptionId: 'prod:prod_nexo_volve',
            providerEventId: 'nexo_menu_b2',
          }),
        }
      );
      assert.equal(pickVolveRes.status, 200);
      const pickVolveJson = (await pickVolveRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string; options?: Array<{ id: string; label: string }> };
      };
      assert.equal(pickVolveJson.botReplied, true);
      assert.match(
        pickVolveJson.outgoingMessage?.text ?? '',
        /Podemos derivar tu consulta sobre VOLVÉ al equipo de NEXO/
      );
      assert.deepEqual(
        pickVolveJson.outgoingMessage?.options?.map((o) => o.id),
        ['cmd_humano', 'cmd_entry_menu']
      );

      // Si escribe texto libre aquí, NO ejecuta Opting ni queda bloqueado: vuelve a ofrecer la alternativa configurable
      const freeTextVolveRes = await webApp.request(
        `http://localhost/api/conversations/${startB.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'Quiero saber cómo funciona',
            providerEventId: 'nexo_menu_b2b',
          }),
        }
      );
      assert.equal(freeTextVolveRes.status, 200);
      const freeTextVolveJson = (await freeTextVolveRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string; options?: Array<{ id: string; label: string }> };
      };
      assert.equal(freeTextVolveJson.botReplied, true);
      assert.match(
        freeTextVolveJson.outgoingMessage?.text ?? '',
        /Podemos derivar tu consulta sobre VOLVÉ/
      );

      // Al confirmar atención humana -> crea tarea humana para VOLVÉ y pasa a esperando_humano
      const confirmHandoffRes = await webApp.request(
        `http://localhost/api/conversations/${startB.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'Solicitar atención humana.',
            selectedOptionId: 'cmd_humano',
            providerEventId: 'nexo_menu_b3',
          }),
        }
      );
      assert.equal(confirmHandoffRes.status, 200);
      const confirmHandoffJson = (await confirmHandoffRes.json()) as {
        botReplied: boolean;
        handoffTask?: { id: string; productName?: string; status: string };
      };
      assert.equal(confirmHandoffJson.botReplied, true);
      assert.equal(confirmHandoffJson.handoffTask?.productName, 'VOLVÉ');
      assert.equal(confirmHandoffJson.handoffTask?.status, 'pendiente');

      // 5. Cliente C elige GIRO, luego "Elegir otro producto" y selecciona Nala -> abre Nala v2
      const startCRes = await webApp.request('http://localhost/api/simulator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          connectionId: prodConnId,
          externalUserId: '50680110003',
          contactPhone: '+50680110003',
        }),
      });
      const startC = (await startCRes.json()) as { conversation: { id: string } };

      await webApp.request(`http://localhost/api/conversations/${startC.conversation.id}/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: 'Hola', providerEventId: 'nexo_menu_c1' }),
      });

      const pickGiroRes = await webApp.request(
        `http://localhost/api/conversations/${startC.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'GIRO',
            selectedOptionId: 'prod:prod_nexo_giro',
            providerEventId: 'nexo_menu_c2',
          }),
        }
      );
      const pickGiroJson = (await pickGiroRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string };
      };
      assert.equal(pickGiroJson.botReplied, true);
      assert.match(pickGiroJson.outgoingMessage?.text ?? '', /consulta sobre GIRO/);

      const backMenuRes = await webApp.request(
        `http://localhost/api/conversations/${startC.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: 'Elegir otro producto.',
            selectedOptionId: 'cmd_entry_menu',
            providerEventId: 'nexo_menu_c3',
          }),
        }
      );
      const backMenuJson = (await backMenuRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { options?: Array<{ id: string; label: string }> };
      };
      assert.equal(backMenuJson.botReplied, true);
      assert.deepEqual(
        backMenuJson.outgoingMessage?.options?.map((o) => o.label),
        ['Opting', 'VOLVÉ', 'BenefitOS', 'GIRO', 'Nala']
      );

      const pickNalaFromCRes = await webApp.request(
        `http://localhost/api/conversations/${startC.conversation.id}/inbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
          body: JSON.stringify({
            text: '5',
            providerEventId: 'nexo_menu_c4',
          }),
        }
      );
      const pickNalaFromCJson = (await pickNalaFromCRes.json()) as {
        botReplied: boolean;
        outgoingMessage?: { text: string };
      };
      assert.equal(pickNalaFromCJson.botReplied, true);
      assert.match(pickNalaFromCJson.outgoingMessage?.text ?? '', /NALA_V2_PUBLICADA_EXACTA/);
    }
  );
});

test('Publicar menú sin mensaje alternativo de atención humana rechaza opciones activas sin conversación publicada', async () => {
  await withTempStore(
    (store) => {
      const nexo = store.businesses.find((b) => b.id === 'biz_nexo')!;
      const optingFlow = store.flowVersions.find((f) => f.id === nexo.activeFlowVersionId)!;
      saveFlowDraft(
        store,
        'biz_nexo',
        'user_michael',
        structuredClone(optingFlow.steps),
        structuredClone(optingFlow.outOfScriptRules),
        'Opting',
        undefined,
        'opting'
      );
      publishFlowDraft(store, 'biz_nexo', 'user_michael', 'opting');
    },
    async () => {
      const pubRes = await webApp.request('http://localhost/api/entry-menu/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          entryConfig: {
            enabled: true,
            greetingPrompt: 'Hola NEXO',
            unconfiguredProductPrompt: '',
          },
          products: [
            {
              id: 'prod_nexo_giro',
              name: 'GIRO',
              optionLabel: 'GIRO',
              referencePrefix: 'giro',
              targetType: 'flow',
              active: true,
            },
          ],
        }),
      });
      assert.equal(pubRes.status, 400);
      const errJson = (await pubRes.json()) as { error: string };
      assert.match(errJson.error, /mensaje alternativo de atención humana/i);
    }
  );
});
