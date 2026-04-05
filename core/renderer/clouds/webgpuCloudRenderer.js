import { CloudRenderer } from './cloudRenderer.js';
import { Material } from '../resources/material.js';
import { RenderTarget } from '../resources/renderTarget.js';
import { CloudVolumeSelector } from './CloudVolumeSelector.js';
import { ProxyCloudPass } from './ProxyCloudPass.js';
import { getCloudCommonWGSL, CLOUD_VOLUME_STRUCTS_WGSL } from './shaders/cloudCommon.wgsl.js';
import { Vector2, Vector3, Matrix4 } from '../../../shared/math/index.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js'
import { VolumetricCloudPass } from './VolumetricCloudPass.js';

export class WebGPUCloudRenderer extends CloudRenderer {
    _ensureHistoryTargets() {
        const w = this.quarterResWidth;
        const h = this.quarterResHeight;

        for (let idx = 0; idx < 2; idx++) {
            const rt = this.historyTargets[idx];
            if (!rt || rt.width !== w || rt.height !== h) {
                if (rt) {
                    this.backend.deleteRenderTarget?.(rt);
                    rt.dispose?.();
                }
                this.historyTargets[idx] = new RenderTarget(w, h, {
                    colorCount: 1,
                    depthBuffer: true,
                    format: this.renderFormat
                });
                this.historyValid = false;
            }
        }
    }

    _ensureQuarterResTarget(fullWidth, fullHeight) {
        const qw = Math.max(1, Math.ceil(fullWidth * 0.5));
        const qh = Math.max(1, Math.ceil(fullHeight * 0.5));

        if (this.quarterResWidth === qw && this.quarterResHeight === qh && this.quarterResTarget) {
            return;
        }

        if (this.quarterResTarget) {
            this.backend.deleteRenderTarget?.(this.quarterResTarget);
            this.quarterResTarget.dispose?.();
        }

        this.quarterResWidth = qw;
        this.quarterResHeight = qh;

        this.quarterResTarget = new RenderTarget(qw, qh, {
            colorCount: 1,
            depthBuffer: false
        });
    }

    _ensureCirrusTarget(fullWidth, fullHeight, scale) {
        const tw = Math.max(1, Math.ceil(fullWidth * scale));
        const th = Math.max(1, Math.ceil(fullHeight * scale));

        if (this.cirrusTarget && this.cirrusTargetWidth === tw && this.cirrusTargetHeight === th) {
            return;
        }

        if (this.cirrusTarget) {
            this.backend.deleteRenderTarget?.(this.cirrusTarget);
            this.cirrusTarget.dispose?.();
        }

        this.cirrusTargetWidth = tw;
        this.cirrusTargetHeight = th;
        this.cirrusTarget = new RenderTarget(tw, th, {
            colorCount: 1,
            depthBuffer: true,
            format: this.backend.format || 'rgba8unorm'
        });
    }

    _getCirrusQualityKey() {
        const raw = `${this.config.cirrusQuality || 'high'}`.toLowerCase();
        if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'ultra') {
            return raw;
        }
        return 'high';
    }

    _getCirrusQualitySettings() {
        const key = this._getCirrusQualityKey();
        if (key === 'low') {
            return {
                key,
                renderScale: 0.5,
                flowPasses: 0,
                warpStrength: 0.06,
                baseLod: 1.5,
                detailLod: 1.1,
                erosionLod: 0.9,
                detailFreq: 2.0,
                erosionFreq: 3.5,
                useErosion: false,
                extraDetail: false,
                extraDetailFreq: 4.0,
                extraDetailLod: 0.0,
                extraDetailWeight: 0.0
            };
        }
        if (key === 'medium') {
            return {
                key,
                renderScale: 1.0,
                flowPasses: 1,
                warpStrength: 0.1,
                baseLod: 1.2,
                detailLod: 0.9,
                erosionLod: 0.5,
                detailFreq: 2.3,
                erosionFreq: 4.2,
                useErosion: true,
                extraDetail: false,
                extraDetailFreq: 4.4,
                extraDetailLod: 0.0,
                extraDetailWeight: 0.0
            };
        }
        if (key === 'ultra') {
            return {
                key,
                renderScale: 1.0,
                flowPasses: 2,
                warpStrength: 0.12,
                baseLod: 1.0,
                detailLod: 0.35,
                erosionLod: 0.0,
                detailFreq: 3.0,
                erosionFreq: 5.6,
                useErosion: true,
                extraDetail: true,
                extraDetailFreq: 4.8,
                extraDetailLod: 0.0,
                extraDetailWeight: 0.25
            };
        }
        return {
            key,
            renderScale: 1.0,
            flowPasses: 2,
            warpStrength: 0.12,
            baseLod: 1.0,
            detailLod: 0.5,
            erosionLod: 0.0,
            detailFreq: 2.7,
            erosionFreq: 5.1,
            useErosion: true,
            extraDetail: false,
            extraDetailFreq: 4.6,
            extraDetailLod: 0.0,
            extraDetailWeight: 0.0
        };
    }

    _ensureVolumeParamsBuffer() {
        if (!this._volumeParamsBuffer) {
            this._volumeParamsBuffer = this.backend.device.createBuffer({
                size: 288,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                label: 'VolumeParams'
            });
        }
    }

    update(camera, environmentState, uniformManager) {
        if (!this.initialized || !this.material || !this.planetConfig) return;
        const cumulusEnabled = this.config.cumulusEnabled !== false;

        if (this.noiseGenerator) {
            this.noiseGenerator.update(camera, environmentState, uniformManager, this.planetConfig);
        }

        // --- Time & Delta Calculation ---
        const now = performance.now() / 1000;
        const dt = Math.min(Math.max(0, now - this._lastTime), 0.1);
        this._lastTime = now;

        // --- SMOOTHING LOGIC ---
        const targetWindDir = environmentState?.windDirection || new Vector2(1, 0);
        const targetWindSpeed = environmentState?.windSpeed || 5.0;
        const lerpFactor = 0.05 * dt;

        this._smoothedWindSpeed += (targetWindSpeed - this._smoothedWindSpeed) * lerpFactor;
        this._smoothedWindDir.x += (targetWindDir.x - this._smoothedWindDir.x) * lerpFactor;
        this._smoothedWindDir.y += (targetWindDir.y - this._smoothedWindDir.y) * lerpFactor;
        this._smoothedWindDir.normalize();

        // Update layers
        const cloudLayersArray = environmentState?.cloudLayers || [];
        const cloudLayersByName = {};
        for (const layer of cloudLayersArray) {
            if (layer && layer.name) cloudLayersByName[layer.name] = layer;
        }
        this._updateSmoothedLayers(cloudLayersByName, lerpFactor);

        // Accumulate Wind Offset
        this._windOffset.x += this._smoothedWindDir.x * this._smoothedWindSpeed * dt;
        this._windOffset.y += this._smoothedWindDir.y * this._smoothedWindSpeed * dt;

        this.frameCount++;

        // --- Update Cloud Volume Selector ---
        if (this.volumeSelector) {
            this.volumeSelector.update(camera, environmentState, this.planetConfig);

            // Upload volume params to GPU
            this._ensureVolumeParamsBuffer();
            const paramsData = this.volumeSelector.getParamsBuffer();
            this.backend.device.queue.writeBuffer(this._volumeParamsBuffer, 0, paramsData);

            // Update the uniform value reference
            this.material.uniforms.volumeParams.value = paramsData;
        }

        // --- Camera & Matrices ---
        const viewMatrix = camera.matrixWorldInverse;
        const projectionMatrix = camera.projectionMatrix;
        const inverseProjection = projectionMatrix.clone().invert();
        const inverseView = viewMatrix.clone().invert();

        const camDir = new Vector3();
        if (typeof camera.getWorldDirection === 'function') {
            camera.getWorldDirection(camDir);
        } else if (camera.matrixWorld) {
            const m = camera.matrixWorld.elements;
            camDir.set(-m[8], -m[9], -m[10]).normalize();
        } else if (camera.target) {
            camDir.subVectors(camera.target, camera.position);
            if (camDir.lengthSq() > 1e-6) camDir.normalize();
        }
        const camDelta = camera.position.distanceTo(this.prevCamPos);
        const angDelta = camDir.lengthSq() > 1e-6 && this.prevViewDir.lengthSq() > 1e-6
            ? camDir.angleTo(this.prevViewDir)
            : Math.PI;
        if (camDelta > 5.0 || angDelta > 0.15) {
            this.historyValid = false;
        }

        // === Matrix Uniforms (64 floats) ===
        const matBuffer = this.material.uniforms.matrixUniforms.value;
        matBuffer.set(inverseView.elements, 0);
        matBuffer.set(inverseProjection.elements, 16);
        matBuffer[32] = camera.position.x;
        matBuffer[33] = camera.position.y;
        matBuffer[34] = camera.position.z;
        matBuffer[35] = 0.0;
        matBuffer.set(this.prevViewProj.elements, 36);
        for (let j = 52; j < 64; j++) matBuffer[j] = 0.0;

        // === Cloud Params (160 floats) ===
        const cloudBuffer = this.material.uniforms.cloudParams.value;
        const sunDir = (environmentState?.sunLightDirection ||
            uniformManager?.uniforms?.sunLightDirection?.value ||
            new Vector3(0, 1, 0)).clone().normalize();

        const origin = this.planetConfig.origin || new Vector3(0, 0, 0);
        const planetRadius = this.planetConfig.radius || 2048;
        const atmosphereHeight = this.planetConfig.atmosphereHeight || planetRadius * 0.2;
        const cumulusInner = this.planetConfig.cumulusInnerRadius || planetRadius + atmosphereHeight * 0.05;
        const cumulusOuter = this.planetConfig.cumulusOuterRadius || planetRadius + atmosphereHeight * 0.15;

        const time = (performance.now() / 1000) % 100000;
        const baseTileSize = Math.max((cumulusOuter - cumulusInner) * 12.0, 8000.0);
        const detailTileSize = Math.max((cumulusOuter - cumulusInner) * 4.0, 3000.0);
        const erosionTileSize = Math.max((cumulusOuter - cumulusInner) * 1.5, 1000.0);

        const lodParams = this.getLODParams(camera);

        const fullWidth = this.backend._viewport?.width || this.backend.canvas.width;
        const fullHeight = this.backend._viewport?.height || this.backend.canvas.height;

        let i = 0;
        cloudBuffer[i++] = origin.x;
        cloudBuffer[i++] = origin.y;
        cloudBuffer[i++] = origin.z;
        cloudBuffer[i++] = planetRadius;

        cloudBuffer[i++] = cumulusInner;
        cloudBuffer[i++] = cumulusOuter;
        cloudBuffer[i++] = this.planetConfig.cirrusInnerRadius || 0;
        cloudBuffer[i++] = this.planetConfig.cirrusOuterRadius || 0;

        cloudBuffer[i++] = sunDir.x;
        cloudBuffer[i++] = sunDir.y;
        cloudBuffer[i++] = sunDir.z;
        cloudBuffer[i++] = environmentState?.sunIntensity || 5.0;

        cloudBuffer[i++] = 0.5;
        cloudBuffer[i++] = time;
        cloudBuffer[i++] = this._smoothedWindSpeed;
        cloudBuffer[i++] = this.config.cloudAnisotropy;

        cloudBuffer[i++] = this._smoothedWindDir.x;
        cloudBuffer[i++] = this._smoothedWindDir.y;
        cloudBuffer[i++] = baseTileSize;
        cloudBuffer[i++] = detailTileSize;

        cloudBuffer[i++] = erosionTileSize;
        const historyBlend = this.historyValid ? 0.92 : 0.0;
        cloudBuffer[i++] = historyBlend;
        cloudBuffer[i++] = this.historyValid ? 1.0 : 0.0;
        const weather = environmentState?.currentWeather || 'clear';
        const wt = weather === 'storm' ? 2 : (weather === 'rain' ? 1 : 0);
        cloudBuffer[i++] = wt;

        cloudBuffer[i++] = lodParams.steps;
        cloudBuffer[i++] = lodParams.shadowSamples;
        cloudBuffer[i++] = this.frameCount % 16;
        cloudBuffer[i++] = 0.5;

        cloudBuffer[i++] = this._windOffset.x;
        cloudBuffer[i++] = this._windOffset.y;
        const lowOnly = this.config.volumetricLayerMode === 'lowOnly';
        cloudBuffer[i++] = lowOnly ? 1.0 : 0.0;

        cloudBuffer[i++] = fullWidth;
        cloudBuffer[i++] = fullHeight;

        while (i < 48) cloudBuffer[i++] = 0.0;

        // Layers
        const layerNames = ['low', 'mid', 'high'];
        for (const layerName of layerNames) {
            const layer = this._smoothedLayers[layerName];
            cloudBuffer[i++] = layer.altMin;
            cloudBuffer[i++] = layer.altMax;
            cloudBuffer[i++] = layer.coverage;
            cloudBuffer[i++] = layer.densityMultiplier;
            cloudBuffer[i++] = layer.noiseScale;
            cloudBuffer[i++] = layer.verticalStretch;
            cloudBuffer[i++] = layer.worleyInfluence;
            cloudBuffer[i++] = layer.edgeSoftness;
            cloudBuffer[i++] = layer.extinction;
            cloudBuffer[i++] = layer.albedo;
            cloudBuffer[i++] = layer.cauliflower ?? 0.35;
            cloudBuffer[i++] = 0.0;
            cloudBuffer[i++] = 0.0;
            cloudBuffer[i++] = 0.0;
            cloudBuffer[i++] = 0.0;
            cloudBuffer[i++] = 0.0;
        }
        while (i < 96) cloudBuffer[i++] = 0.0;

        // === Volume tuning params (appended) ===
        const tierA = this.volumeSelector?.getTierAMaxDist?.() ?? 8000;
        const tierB = this.volumeSelector?.getTierBMaxDist?.() ?? 25000;
        const fadeStart = tierB * 0.6;
        const fadeEnd = tierB;
        const cellSize = this.volumeSelector?.getCellSize?.() ?? 3000;
        const fogCellSize = this.volumeSelector?.getFogCellSize?.() ?? 800;
        const minCoverage = this.volumeSelector?.getMinCoverage?.() ?? 0.1;
        const debugFlags = this.volumeSelector?.getDebugFixedVolumes?.() ? 1.0 : 0.0;

        cloudBuffer[i++] = tierA;
        cloudBuffer[i++] = tierB;
        cloudBuffer[i++] = fadeStart;
        cloudBuffer[i++] = fadeEnd;
        cloudBuffer[i++] = cellSize;
        cloudBuffer[i++] = fogCellSize;
        cloudBuffer[i++] = minCoverage;
        cloudBuffer[i++] = debugFlags;

        while (i < 160) cloudBuffer[i++] = 0.0;

        // === Weather Params ===
        const weatherParams = this.material.uniforms.weatherParams.value;
        const weatherMap = environmentState?.weatherMap || null;
        if (weatherMap && weatherMap.current) {
            weatherParams[0] = weatherMap.blend ?? 1.0;
            weatherParams[1] = 1.0;
            weatherParams[2] = weatherMap.resolution ?? 0.0;
            weatherParams[3] = 0.0;
        } else {
            weatherParams[0] = 1.0;
            weatherParams[1] = 0.0;
            weatherParams[2] = 0.0;
            weatherParams[3] = 0.0;
        }

        // === Atmosphere Params ===
        if (uniformManager && uniformManager.uniforms.atmosphereRadius) {
            const atmoBuffer = this.material.uniforms.atmosphereParams.value;
            const u = uniformManager.uniforms;

            atmoBuffer[0] = u.atmosphereRadius.value;
            atmoBuffer[1] = u.atmosphereScaleHeightRayleigh.value;
            atmoBuffer[2] = u.atmosphereScaleHeightMie.value;
            atmoBuffer[3] = u.atmosphereMieAnisotropy.value;

            atmoBuffer[4] = u.atmosphereRayleighScattering.value.x;
            atmoBuffer[5] = u.atmosphereRayleighScattering.value.y;
            atmoBuffer[6] = u.atmosphereRayleighScattering.value.z;
            atmoBuffer[7] = u.atmosphereMieScattering.value;
        }

        // === Textures ===
        if (this.noiseGenerator) {
            const baseView = this.noiseGenerator.getBaseTextureView?.();
            const detailView = this.noiseGenerator.getDetailTextureView?.();
            const erosionView = this.noiseGenerator.getErosionTextureView?.();
            if (baseView) this.material.uniforms.noiseBase.value = { _isGPUTextureView: true, view: baseView };
            if (detailView) this.material.uniforms.noiseDetail.value = { _isGPUTextureView: true, view: detailView };
            if (erosionView) this.material.uniforms.noiseErosion.value = { _isGPUTextureView: true, view: erosionView };

            if (cumulusEnabled) {
                const volBaseView = this.noiseGenerator.getVolBaseTextureView?.();
                const volDetailView = this.noiseGenerator.getVolDetailTextureView?.();
                if (volBaseView) this.material.uniforms.noiseVolBase.value = { _isGPUTextureView: true, view: volBaseView };
                if (volDetailView) this.material.uniforms.noiseVolDetail.value = { _isGPUTextureView: true, view: volDetailView };
            } else {
                this.material.uniforms.noiseVolBase.value = null;
                this.material.uniforms.noiseVolDetail.value = null;
            }
        }

        if (weatherMap?.current) {
            this.material.uniforms.weatherCurrent.value = { _isGPUTextureView: true, view: weatherMap.current };
            if (weatherMap.previous) {
                this.material.uniforms.weatherPrevious.value = { _isGPUTextureView: true, view: weatherMap.previous };
            }
        }

        if (uniformManager && uniformManager.uniforms.transmittanceLUT?.value) {
            const tLUT = uniformManager.uniforms.transmittanceLUT.value;
            if (tLUT && tLUT._gpuTexture) {
                this.material.uniforms.transmittanceLUT.value = tLUT;
            }
        }

        const depthTextureView = this.backend.getDepthTextureView?.();
        if (depthTextureView) {
            this.material.uniforms.sceneDepthTexture.value = { _isGPUTextureView: true, view: depthTextureView };
        }

        // === Update Proxy Pass ===
        if (cumulusEnabled && this.proxyPass) {
          this.proxyPass.update(this.volumeSelector);
          
          this.proxyPass.setSharedResources({
              matrixUniforms: this.material.uniforms.matrixUniforms.value,
              cloudParams: this.material.uniforms.cloudParams.value,
              atmosphereParams: this.material.uniforms.atmosphereParams.value,
              volumeParamsData: this.volumeSelector.getParamsBuffer(),
              noiseBase: this.material.uniforms.noiseBase.value,
              noiseDetail: this.material.uniforms.noiseDetail.value,
              noiseErosion: this.material.uniforms.noiseErosion.value,
              transmittanceLUT: this.material.uniforms.transmittanceLUT.value,
              sceneDepthTexture: this.material.uniforms.sceneDepthTexture.value
          });
      }

      // === NEW: Update Volumetric Pass ===
      if (cumulusEnabled && this.volumetricPass) {
          this.volumetricPass.update(this.volumeSelector);
          
          this.volumetricPass.setSharedResources({
              matrixUniforms: this.material.uniforms.matrixUniforms.value,
              cloudParams: this.material.uniforms.cloudParams.value,
              atmosphereParams: this.material.uniforms.atmosphereParams.value,
              volumeParamsData: this.volumeSelector.getParamsBuffer(),
              noiseVolBase: this.material.uniforms.noiseVolBase.value,
              noiseVolDetail: this.material.uniforms.noiseVolDetail.value,
              noiseErosion: this.material.uniforms.noiseErosion.value,
              transmittanceLUT: this.material.uniforms.transmittanceLUT.value,
              sceneDepthTexture: this.material.uniforms.sceneDepthTexture.value
          });
      }
    }

    _updateSmoothedLayers(targetLayers, t) {
        const names = ['low', 'mid', 'high'];
        for (const name of names) {
            const target = targetLayers[name] || this._defaultLayerParams;
            const current = this._smoothedLayers[name];

            current.altMin += (target.altMin - current.altMin) * t;
            current.altMax += (target.altMax - current.altMax) * t;
            current.coverage += (target.coverage - current.coverage) * t;
            current.densityMultiplier += ((target.densityMultiplier || 0.5) - current.densityMultiplier) * t;
            current.noiseScale += ((target.noiseScale || 1.0) - current.noiseScale) * t;
            current.verticalStretch += ((target.verticalStretch || 1.0) - current.verticalStretch) * t;
            current.worleyInfluence += ((target.worleyInfluence || 0.5) - current.worleyInfluence) * t;
            current.edgeSoftness += ((target.edgeSoftness || 0.5) - current.edgeSoftness) * t;
            current.extinction += ((target.extinction || 0.05) - current.extinction) * t;
            current.albedo += ((target.albedo || 0.9) - current.albedo) * t;
            current.cauliflower += ((target.cauliflower ?? 0.35) - (current.cauliflower ?? 0.35)) * t;
        }
    }

    render(camera, environmentState, uniformManager) {
      if (!this.initialized || !this.material || !this.noiseGenerator) return;
      if (!this.material.uniforms.noiseBase.value) return;

      const cumulusEnabled = this.config.cumulusEnabled !== false;
      const fullWidth = this.backend._viewport?.width || this.backend.canvas.width;
      const fullHeight = this.backend._viewport?.height || this.backend.canvas.height;

      if (cumulusEnabled) {
          this._ensureQuarterResTarget(fullWidth, fullHeight);
          this._ensureHistoryTargets();
      }

      // 1. Dispatch Compute (Keep this so Cirrus works/animates)
      this.backend.endRenderPassForCompute();
      const commandEncoder = this.backend.getCommandEncoder();
      this.noiseGenerator.dispatch(commandEncoder);
      
      if (!cumulusEnabled) {
          // Resume the main render pass so subsequent calls (like renderCirrus) work
          this.backend.resumeRenderPass();
          return;
      }

      const historyRead = this.historyValid ? this.historyTargets[this.historyPing ^ 1] : null;
      const historyWrite = this.historyTargets[this.historyPing];

      if (historyRead && historyRead._gpuRenderTarget) {
          const histView = historyRead._gpuRenderTarget.colorViews[0];
          if (histView) {
              this.material.uniforms.historyTexture.value = { _isGPUTextureView: true, view: histView };
          } else {
              this.material.uniforms.historyTexture.value = null;
          }
      } else {
          this.material.uniforms.historyTexture.value = null;
      }

      const qw = this.quarterResWidth;
      const qh = this.quarterResHeight;
      this.backend.setRenderTarget(historyWrite);
      this.backend.setViewport(0, 0, qw, qh);
      this.backend.clear(true, false);
      
      // Render main cumulus shell (Tier C - far distance, background)
      this.backend.draw(this.fullscreenGeometry, this.material);

      this.backend.setRenderTarget(null);
      this.backend.setViewport(0, 0, fullWidth, fullHeight);
      this.backend.resumeRenderPass();

      if (historyWrite._gpuRenderTarget) {
          const srcView = historyWrite._gpuRenderTarget.colorViews[0];
          if (srcView) {
              this.blitMaterial.uniforms.sourceTexture.value = { _isGPUTextureView: true, view: srcView };
          }
      }

      const blitParams = this.blitMaterial.uniforms.blitParams.value;
      blitParams[0] = 1.0 / qw;
      blitParams[1] = 1.0 / qh;
      blitParams[2] = 0.0;
      blitParams[3] = 0.0;

      // Blit shell to full resolution
      this.backend.draw(this.fullscreenGeometry, this.blitMaterial);

      // === NEW: Render Volumetric Pass (Tier A - close distance) ===
      // Rendered first among the volume passes so it's behind proxy where they overlap
      if (this.volumetricPass && this.volumetricPass.enabled) {
          this.volumetricPass.render(this.backend);
      }

      // === Render Proxy Pass (Tier B - medium distance) ===
      if (this.proxyPass && this.proxyPass.enabled) {
          this.proxyPass.render(this.backend);
      }

      this.historyPing ^= 1;
      this.historyValid = true;

      // ... [Keep existing camera state updates]
      this.prevViewMatrix.copy(camera.matrixWorldInverse);
      this.prevProjectionMatrix.copy(camera.projectionMatrix);
      this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.prevCamPos.copy(camera.position);
      if (typeof camera.getWorldDirection === 'function') {
          camera.getWorldDirection(this.prevViewDir);
      } else if (camera.matrixWorld) {
          const m = camera.matrixWorld.elements;
          this.prevViewDir.set(-m[8], -m[9], -m[10]).normalize();
      } else if (camera.target) {
          this.prevViewDir.subVectors(camera.target, camera.position);
          if (this.prevViewDir.lengthSq() > 1e-6) this.prevViewDir.normalize();
      }
  }
  getVolumetricPass() {
    return this.volumetricPass;
}

setVolumetricEnabled(enabled) {
    if (this.volumetricPass) {
        this.volumetricPass.enabled = enabled;
    }
}

    async initialize() {
        await super.initialize();

        this._windOffset = new Vector2(0, 0);
        this._smoothedWindDir = new Vector2(1, 0);
        this._smoothedWindSpeed = 5.0;
        this._lastTime = performance.now() / 1000;

        this._defaultLayerParams = {
            altMin: 0, altMax: 0, coverage: 0, densityMultiplier: 0.5,
            noiseScale: 1.0, verticalStretch: 1.0, worleyInfluence: 0.5,
            edgeSoftness: 0.5, extinction: 0.05, albedo: 0.9, cauliflower: 0.35
        };
        this._smoothedLayers = {
            low: { ...this._defaultLayerParams },
            mid: { ...this._defaultLayerParams },
            high: { ...this._defaultLayerParams }
        };

        const cumulusEnabled = this.config.cumulusEnabled !== false;

        if (cumulusEnabled) {
            // Initialize volume selector
            this.volumeSelector = new CloudVolumeSelector({
                maxVolumes: 4,
                autoScale: true,
                minCoverage: 0.1,
                terrainLiftFactor: 0.25,
                debugFixedVolumes: true
            });

            // Initialize Proxy Pass (Tier B - medium distance)
            this.proxyPass = new ProxyCloudPass(this.backend, {
                maxSteps: 32,
                shadowSteps: 3,
                minLodBlend: 0.0,
                maxLodBlend: 1.0
            });
            await this.proxyPass.initialize();

            // NEW: Initialize Volumetric Pass (Tier A - close distance)
            this.volumetricPass = new VolumetricCloudPass(this.backend, {
                maxSteps: 96,
                shadowSteps: 6,
                maxLodBlend: 0.95
            });
            await this.volumetricPass.initialize();
        } else {
            this.volumeSelector = null;
            this.proxyPass = null;
            this.volumetricPass = null;
        }

        this.renderFormat = this.backend.format || 'rgba8unorm';
        this.historyTargets = [null, null];
        this.historyPing = 0;
        this.historyValid = false;
        this.prevViewMatrix = new Matrix4();
        this.prevProjectionMatrix = new Matrix4();
        this.prevViewProj = new Matrix4();
        this.prevCamPos = new Vector3();
        this.prevViewDir = new Vector3();
        this.frameCount = 0;
        this.quarterResTarget = null;
        this.quarterResWidth = 0;
        this.quarterResHeight = 0;
        this.cirrusTarget = null;
        this.cirrusTargetWidth = 0;
        this.cirrusTargetHeight = 0;
        this._cirrusQualitySettings = this._getCirrusQualitySettings();

        this.material = new Material({
            name: 'VolumetricClouds_WebGPU',
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'CloudUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'matrixUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'cloudParams' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'weatherParams' },
                        { binding: 3, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'atmosphereParams' },
                        { binding: 4, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'volumeParams' }
                    ]
                },
                {
                    label: 'CloudTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseBase' },
                        { binding: 1, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseDetail' },
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseErosion' },
                        { binding: 3, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d-array' }, name: 'weatherCurrent' },
                        { binding: 4, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d-array' }, name: 'weatherPrevious' },
                        { binding: 5, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerRepeat' },
                        { binding: 6, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerClamp' },
                        { binding: 7, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'historyTexture' },
                        { binding: 8, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'transmittanceLUT' },
                        { binding: 9, visibility: 'fragment', texture: { sampleType: 'depth', viewDimension: '2d' }, name: 'sceneDepthTexture' },
                        { binding: 10, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseVolBase' },
                        { binding: 11, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseVolDetail' }
                    ]
                }
            ],
            uniforms: {
                matrixUniforms: { value: new Float32Array(64) },
                cloudParams: { value: new Float32Array(160) },
                weatherParams: { value: new Float32Array(4) },
                atmosphereParams: { value: new Float32Array(12) },
                volumeParams: { value: new Float32Array(4 + 4 * 16) },
                noiseBase: { value: null },
                noiseDetail: { value: null },
                noiseErosion: { value: null },
                weatherCurrent: { value: null },
                weatherPrevious: { value: null },
                noiseSamplerRepeat: { value: 'linear-repeat' },
                noiseSamplerClamp: { value: 'linear' },
                historyTexture: { value: null },
                transmittanceLUT: { value: null },
                sceneDepthTexture: { value: null },
                noiseVolBase: { value: null },
                noiseVolDetail: { value: null }
            },
            transparent: false,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'normal'
        });

        this.blitMaterial = new Material({
            name: 'CloudBlit',
            vertexShader: this._getBlitVertexShader(),
            fragmentShader: this._getBlitFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'BlitTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'sourceTexture' },
                        { binding: 1, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'sourceSampler' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'blitParams' }
                    ]
                }
            ],
            uniforms: {
                sourceTexture: { value: null },
                sourceSampler: { value: 'linear' },
                blitParams: { value: new Float32Array(4) }
            },
            transparent: true,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'premultiplied'
        });

        this.cirrusMaterial = new Material({
            name: 'CirrusShell_WebGPU',
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getCirrusFragmentShader(),
            vertexLayout: [],
            bindGroupLayoutSpec: [
                {
                    label: 'CirrusUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'matrixUniforms' },
                        { binding: 1, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'cloudParams' },
                        { binding: 2, visibility: 'fragment', buffer: { type: 'uniform' }, name: 'atmosphereParams' }
                    ]
                },
                {
                    label: 'CirrusTextures',
                    entries: [
                        { binding: 0, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseBase' },
                        { binding: 1, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseDetail' },
                        { binding: 2, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '3d' }, name: 'noiseErosion' },
                        { binding: 3, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerRepeat' },
                        { binding: 4, visibility: 'fragment', texture: { sampleType: 'float', viewDimension: '2d' }, name: 'transmittanceLUT' },
                        { binding: 5, visibility: 'fragment', sampler: { type: 'filtering' }, name: 'noiseSamplerClamp' }
                    ]
                }
            ],
            uniforms: {
                matrixUniforms: { value: new Float32Array(64) },
                cloudParams: { value: new Float32Array(160) },
                atmosphereParams: { value: new Float32Array(12) },
                noiseBase: { value: null },
                noiseDetail: { value: null },
                noiseErosion: { value: null },
                noiseSamplerRepeat: { value: 'linear-repeat' },
                transmittanceLUT: { value: null },
                noiseSamplerClamp: { value: 'linear' }
            },
            transparent: true,
            depthTest: true,
            depthWrite: false,
            depthCompare: 'always',
            blending: 'premultiplied'
        });

        this.initialized = true;
    }

    renderCirrus(camera, environmentState, uniformManager) {
        if (!this.initialized || !this.cirrusMaterial || !this.noiseGenerator) return;
        if (!this.material.uniforms.noiseBase.value) return;

        this.cirrusMaterial.uniforms.matrixUniforms.value = this.material.uniforms.matrixUniforms.value;
        this.cirrusMaterial.uniforms.cloudParams.value = this.material.uniforms.cloudParams.value;
        this.cirrusMaterial.uniforms.atmosphereParams.value = this.material.uniforms.atmosphereParams.value;
        this.cirrusMaterial.uniforms.noiseBase.value = this.material.uniforms.noiseBase.value;
        this.cirrusMaterial.uniforms.noiseDetail.value = this.material.uniforms.noiseDetail.value;
        this.cirrusMaterial.uniforms.noiseErosion.value = this.material.uniforms.noiseErosion.value;
        this.cirrusMaterial.uniforms.transmittanceLUT.value = this.material.uniforms.transmittanceLUT.value;

        const settings = this._cirrusQualitySettings || this._getCirrusQualitySettings();
        const renderScale = settings.renderScale ?? 1.0;
        if (renderScale < 0.99) {
            const fullWidth = this.backend._viewport?.width || this.backend.canvas.width;
            const fullHeight = this.backend._viewport?.height || this.backend.canvas.height;
            this._ensureCirrusTarget(fullWidth, fullHeight, renderScale);

            const tw = this.cirrusTargetWidth;
            const th = this.cirrusTargetHeight;
            this.backend.setClearColor(0.0, 0.0, 0.0, 0.0);
            this.backend.setRenderTarget(this.cirrusTarget);
            this.backend.setViewport(0, 0, tw, th);
            this.backend.clear(true, false);
            this.backend.draw(this.fullscreenGeometry, this.cirrusMaterial);

            this.backend.setRenderTarget(null);
            this.backend.setViewport(0, 0, fullWidth, fullHeight);
            this.backend.setClearColor(0.0, 0.0, 0.0, 1.0);
            // Preserve existing color while clearing depth after viewport resize.
            this.backend.clear(false, true);

            if (this.cirrusTarget._gpuRenderTarget) {
                const srcView = this.cirrusTarget._gpuRenderTarget.colorViews[0];
                if (srcView) {
                    this.blitMaterial.uniforms.sourceTexture.value = { _isGPUTextureView: true, view: srcView };
                }
            }

            const blitParams = this.blitMaterial.uniforms.blitParams.value;
            blitParams[0] = 1.0 / tw;
            blitParams[1] = 1.0 / th;
            blitParams[2] = 0.0;
            blitParams[3] = 0.0;
            this.backend.draw(this.fullscreenGeometry, this.blitMaterial);
            return;
        }

        this.backend.draw(this.fullscreenGeometry, this.cirrusMaterial);
    }

    getVolumeSelector() {
        return this.volumeSelector;
    }

    // NEW: Get proxy pass for configuration
    getProxyPass() {
        return this.proxyPass;
    }

    // NEW: Enable/disable proxy rendering
    setProxyEnabled(enabled) {
        if (this.proxyPass) {
            this.proxyPass.enabled = enabled;
        }
    }

    setCirrusQuality(quality) {
        const next = `${quality || ''}`.toLowerCase();
        if (this.config.cirrusQuality === next) {
            return this._getCirrusQualityKey();
        }

        this.config.cirrusQuality = next;
        const settings = this._getCirrusQualitySettings();
        this.config.cirrusQuality = settings.key;
        const changed = this._cirrusQualitySettings?.key !== settings.key;
        this._cirrusQualitySettings = settings;

        if (changed && this.cirrusMaterial) {
            this.cirrusMaterial.fragmentShader = this._getCirrusFragmentShader();
            this.cirrusMaterial._needsCompile = true;
            this.cirrusMaterial._gpuPipeline = null;
        }

        return settings.key;
    }

    _getVertexShader() {
        return /* wgsl */`
        struct MatrixUniforms {
            inverseView: mat4x4<f32>,
            inverseProjection: mat4x4<f32>,
            cameraPosition: vec3<f32>,
            _pad0: f32,
            prevViewProj: mat4x4<f32>
        };

        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) uv: vec2<f32>
        };

        @group(0) @binding(0) var<uniform> matrices: MatrixUniforms;

        @vertex
        fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var pos = array<vec2<f32>, 3>(
                vec2<f32>(-1.0, -1.0),
                vec2<f32>( 3.0, -1.0),
                vec2<f32>(-1.0,  3.0)
            );
            var output: VertexOutput;
            output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
            output.uv = pos[vertexIndex] * 0.5 + 0.5;
            return output;
        }
        `;
    }

    _getBlitVertexShader() {
        return /* wgsl */`
        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) uv: vec2<f32>
        };

        @vertex
        fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var pos = array<vec2<f32>, 3>(
                vec2<f32>(-1.0, -1.0),
                vec2<f32>( 3.0, -1.0),
                vec2<f32>(-1.0,  3.0)
            );
            var output: VertexOutput;
            output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
            output.uv = pos[vertexIndex] * 0.5 + 0.5;
            return output;
        }
        `;
    }

    _getBlitFragmentShader() {
        return /* wgsl */`
        struct BlitParams {
            texelWidth: f32,
            texelHeight: f32,
            _pad0: f32,
            _pad1: f32,
        };

        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        @group(0) @binding(1) var sourceSampler: sampler;
        @group(0) @binding(2) var<uniform> params: BlitParams;

        @fragment
        fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
            let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);

            let tx = params.texelWidth;
            let ty = params.texelHeight;

            let c  = textureSampleLevel(sourceTexture, sourceSampler, flippedUV, 0.0);
            let l  = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>(-tx, 0.0), 0.0);
            let r  = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>( tx, 0.0), 0.0);
            let u  = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>(0.0, -ty), 0.0);
            let d  = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>(0.0,  ty), 0.0);
            let tl = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>(-tx, -ty), 0.0);
            let tr = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>( tx, -ty), 0.0);
            let bl = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>(-tx,  ty), 0.0);
            let br = textureSampleLevel(sourceTexture, sourceSampler, flippedUV + vec2<f32>( tx,  ty), 0.0);

            let result = c * 0.25
                       + (l + r + u + d) * 0.125
                       + (tl + tr + bl + br) * 0.0625;

            return result;
        }
        `;
    }
   _getFragmentShader() {
        // Get shared common code
        const cloudCommon = getCloudCommonWGSL();
        
        return /* wgsl */`
      ${AERIAL_PERSPECTIVE_WGSL}
      ${cloudCommon}

      struct MatrixUniforms {
        inverseView: mat4x4<f32>,
        inverseProjection: mat4x4<f32>,
        cameraPosition: vec3<f32>,
        _pad0: f32,
        prevViewProj: mat4x4<f32>
      };

      struct CloudParams {
        planetCenter: vec3<f32>,
        planetRadius: f32,
        cumulusInnerRadius: f32,
        cumulusOuterRadius: f32,
        cirrusInnerRadius: f32,
        cirrusOuterRadius: f32,

        sunDirX: f32,
        sunDirY: f32,
        sunDirZ: f32,
        sunIntensity: f32,

        coverage: f32,
        time: f32,
        windSpeed: f32,
        cloudAnisotropy: f32,

        windDirX: f32,
        windDirY: f32,

        baseTileSize: f32,
        detailTileSize: f32,
        erosionTileSize: f32,

        historyBlend: f32,
        historyValid: f32,
        weatherType: f32,

        lodSteps: f32,
        lodLightSteps: f32,
        frameIndex: f32,
        renderScale: f32,

        windOffsetX: f32,
        windOffsetY: f32,

        volumetricLowOnly: f32,

        viewportWidth: f32,
        viewportHeight: f32,

        _pad3: vec4<f32>,
        _pad4: vec4<f32>,
        _pad5: vec4<f32>,

        layerLow_altMin: f32, layerLow_altMax: f32, layerLow_coverage: f32, layerLow_densityMult: f32,
        layerLow_noiseScale: f32, layerLow_verticalStretch: f32, layerLow_worleyInfluence: f32, layerLow_edgeSoftness: f32,
        layerLow_extinction: f32, layerLow_albedo: f32, layerLow_cauliflower: f32,
        layerLow_pad0: f32, layerLow_pad1: f32, layerLow_pad2: f32, layerLow_pad3: f32, layerLow_pad4: f32,

        layerMid_altMin: f32, layerMid_altMax: f32, layerMid_coverage: f32, layerMid_densityMult: f32,
        layerMid_noiseScale: f32, layerMid_verticalStretch: f32, layerMid_worleyInfluence: f32, layerMid_edgeSoftness: f32,
        layerMid_extinction: f32, layerMid_albedo: f32, layerMid_cauliflower: f32,
        layerMid_pad0: f32, layerMid_pad1: f32, layerMid_pad2: f32, layerMid_pad3: f32, layerMid_pad4: f32,

        layerHigh_altMin: f32, layerHigh_altMax: f32, layerHigh_coverage: f32, layerHigh_densityMult: f32,
        layerHigh_noiseScale: f32, layerHigh_verticalStretch: f32, layerHigh_worleyInfluence: f32, layerHigh_edgeSoftness: f32,
        layerHigh_extinction: f32, layerHigh_albedo: f32, layerHigh_cauliflower: f32,
        layerHigh_pad0: f32, layerHigh_pad1: f32, layerHigh_pad2: f32, layerHigh_pad3: f32, layerHigh_pad4: f32,

        // Volume tuning (extended cloud params)
        volumeTierAMaxDist: f32,
        volumeTierBMaxDist: f32,
        volumeFadeStart: f32,
        volumeFadeEnd: f32,
        volumeCellSize: f32,
        volumeFogCellSize: f32,
        volumeMinCoverage: f32,
        volumeDebugFlags: f32,
        volumePad: array<vec4<f32>, 14>,
      };

      struct WeatherParams {
        blend: f32,
        enabled: f32,
        resolution: f32,
        _pad0: f32,
      };

      struct AtmosphereParams {
        atmosphereRadius: f32,
        scaleHeightRayleigh: f32,
        scaleHeightMie: f32,
        mieAnisotropy: f32,
        rayleighScattering: vec3<f32>,
        mieScattering: f32,
        _pad0: vec4<f32>,
      };

      @group(0) @binding(0) var<uniform> matrices: MatrixUniforms;
      @group(0) @binding(1) var<uniform> params: CloudParams;
      @group(0) @binding(2) var<uniform> weather: WeatherParams;
      @group(0) @binding(3) var<uniform> atmo: AtmosphereParams;
      @group(0) @binding(4) var<uniform> volumeParams: VolumeParams;

      @group(1) @binding(0) var noiseBase: texture_3d<f32>;
      @group(1) @binding(1) var noiseDetail: texture_3d<f32>;
      @group(1) @binding(2) var noiseErosion: texture_3d<f32>;
      @group(1) @binding(3) var weatherCurrent: texture_2d_array<f32>;
      @group(1) @binding(4) var weatherPrevious: texture_2d_array<f32>;
      @group(1) @binding(5) var noiseSamplerRepeat: sampler;
      @group(1) @binding(6) var noiseSamplerClamp: sampler;
      @group(1) @binding(7) var historyTexture: texture_2d<f32>;
      @group(1) @binding(8) var transmittanceLUT: texture_2d<f32>;
      @group(1) @binding(9) var sceneDepthTexture: texture_depth_2d;
      @group(1) @binding(10) var noiseVolBase: texture_3d<f32>;
      @group(1) @binding(11) var noiseVolDetail: texture_3d<f32>;

      const PI: f32 = 3.14159265359;
      const TIME_SCALE: f32 = 0.066;

      fn ridgeNoise(n: f32) -> f32 {
          return 1.0 - abs(n * 2.0 - 1.0);
      }

      fn getLayerCauliflower(layerIdx: i32) -> f32 {
          if (layerIdx == 0) { return params.layerLow_cauliflower; }
          else if (layerIdx == 1) { return params.layerMid_cauliflower; }
          return params.layerHigh_cauliflower;
      }

      fn bayer8(p: vec2<f32>) -> f32 {
        let x = u32(p.x) % 8u;
        let y = u32(p.y) % 8u;
        var m = array<u32, 64>(
          0u, 32u, 8u, 40u, 2u, 34u, 10u, 42u,
          48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
          12u, 44u, 4u, 36u, 14u, 46u, 6u, 38u,
          60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
          3u, 35u, 11u, 43u, 1u, 33u, 9u, 41u,
          51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
          15u, 47u, 7u, 39u, 13u, 45u, 5u, 37u,
          63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u
        );
        return f32(m[y * 8u + x]) / 64.0;
      }

      fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
        let clip = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
        let view = matrices.inverseProjection * clip;
        let world = matrices.inverseView * vec4<f32>(view.xyz / view.w, 0.0);
        return normalize(world.xyz);
      }

      fn remap(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
        return newLo + (v - lo) / max(hi - lo, 0.0001) * (newHi - newLo);
      }

      fn sampleNoise3D(tex: texture_3d<f32>, coord: vec3<f32>, lod: f32) -> vec4<f32> {
        return textureSampleLevel(tex, noiseSamplerRepeat, fract(coord), lod);
      }

      fn domainWarp(coord: vec3<f32>, strength: f32) -> vec3<f32> {
        let warpSample = sampleNoise3D(noiseErosion, coord * 0.25, 2.0).xyz;
        let warp = (warpSample - vec3<f32>(0.5)) * strength;
        return coord + warp;
      }

      fn flowAdvect(coord: vec3<f32>, time: f32, speed: f32, strength: f32) -> vec3<f32> {
        let flowSample = sampleNoise3D(noiseErosion, coord * 0.12 + vec3<f32>(time * speed, 0.0, time * speed), 1.0).xy;
        let flow = (flowSample - vec2<f32>(0.5)) * 2.0;
        return coord + vec3<f32>(flow.x, 0.0, flow.y) * strength;
      }

      fn sampleHistory(uv: vec2<f32>) -> vec4<f32> {
        if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) {
          return vec4<f32>(0.0);
        }
        let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);
        return textureSampleLevel(historyTexture, noiseSamplerClamp, flippedUV, 0.0);
      }

      fn sampleWeatherFace(dir: vec3<f32>, axis: i32) -> vec4<f32> {
        let a = abs(dir);
        var face: i32 = 0;
        var uv: vec2<f32>;

        if (axis == 0) {
          let denom = max(a.x, 1e-6);
          if (dir.x >= 0.0) { face = 0; uv = vec2<f32>(-dir.z, -dir.y) / denom; }
          else { face = 1; uv = vec2<f32>(dir.z, -dir.y) / denom; }
        } else if (axis == 1) {
          let denom = max(a.y, 1e-6);
          if (dir.y >= 0.0) { face = 2; uv = vec2<f32>(dir.x, dir.z) / denom; }
          else { face = 3; uv = vec2<f32>(dir.x, -dir.z) / denom; }
        } else {
          let denom = max(a.z, 1e-6);
          if (dir.z >= 0.0) { face = 4; uv = vec2<f32>(dir.x, -dir.y) / denom; }
          else { face = 5; uv = vec2<f32>(-dir.x, -dir.y) / denom; }
        }

        uv = uv * 0.5 + vec2<f32>(0.5, 0.5);
        let curr = textureSampleLevel(weatherCurrent, noiseSamplerClamp, uv, face, 0.0);
        let prev = textureSampleLevel(weatherPrevious, noiseSamplerClamp, uv, face, 0.0);
        return mix(prev, curr, weather.blend);
      }

      fn sampleWeather(worldPos: vec3<f32>) -> vec4<f32> {
        if (weather.enabled < 0.5) { return vec4<f32>(1.0, 0.0, 0.5, 0.5); }
        let dir = normalize(worldPos - params.planetCenter);
        let a = abs(dir);
        let sum = max(a.x + a.y + a.z, 1e-6);
        let w = a / sum;
        let wx = sampleWeatherFace(dir, 0);
        let wy = sampleWeatherFace(dir, 1);
        let wz = sampleWeatherFace(dir, 2);
        return wx * w.x + wy * w.y + wz * w.z;
      }

      fn rayPlanetIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radius: f32) -> f32 {
        let oc = ro - center;
        let b = dot(oc, rd);
        let c = dot(oc, oc) - radius * radius;
        let disc = b * b - c;
        if (disc < 0.0) { return -1.0; }
        let s = sqrt(disc);
        let t0 = -b - s;
        if (t0 > 0.0) { return t0; }
        let t1 = -b + s;
        if (t1 > 0.0) { return t1; }
        return -1.0;
      }

      fn rayShellIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, rInner: f32, rOuter: f32) -> vec2<f32> {
        return cloudRayShellIntersect(ro, rd, center, rInner, rOuter);
      }

      fn getAltitude(worldPos: vec3<f32>) -> f32 {
        return length(worldPos - params.planetCenter) - params.planetRadius;
      }

      fn getHeightFraction(worldPos: vec3<f32>) -> f32 {
        let dist = length(worldPos - params.planetCenter);
        return (dist - params.cumulusInnerRadius) / max(params.cumulusOuterRadius - params.cumulusInnerRadius, 1.0);
      }

      fn getLayerParams(altitude: f32, layerIdx: i32) -> vec4<f32> {
        var altMin: f32; var altMax: f32; var coverage: f32;
        var densityMult: f32; var worleyInfluence: f32; var edgeSoftness: f32;

        if (layerIdx == 0) {
          altMin = params.layerLow_altMin; altMax = params.layerLow_altMax;
          coverage = params.layerLow_coverage; densityMult = params.layerLow_densityMult;
          worleyInfluence = params.layerLow_worleyInfluence; edgeSoftness = params.layerLow_edgeSoftness;
        } else if (layerIdx == 1) {
          altMin = params.layerMid_altMin; altMax = params.layerMid_altMax;
          coverage = params.layerMid_coverage; densityMult = params.layerMid_densityMult;
          worleyInfluence = params.layerMid_worleyInfluence; edgeSoftness = params.layerMid_edgeSoftness;
        } else {
          altMin = params.layerHigh_altMin; altMax = params.layerHigh_altMax;
          coverage = params.layerHigh_coverage; densityMult = params.layerHigh_densityMult;
          worleyInfluence = params.layerHigh_worleyInfluence; edgeSoftness = params.layerHigh_edgeSoftness;
        }

        if (coverage < 0.01 || altMax <= altMin) { return vec4<f32>(0.0); }
        let hFrac = (altitude - altMin) / (altMax - altMin);
        let layerFade = smoothstep(0.0, 0.15, hFrac) * smoothstep(1.0, 0.85, hFrac);
        return vec4<f32>(coverage * layerFade, densityMult, worleyInfluence, edgeSoftness);
      }

      fn getLayerVerticalStretch(layerIdx: i32) -> f32 {
        if (layerIdx == 0) { return params.layerLow_verticalStretch; }
        else if (layerIdx == 1) { return params.layerMid_verticalStretch; }
        return params.layerHigh_verticalStretch;
      }

      fn getLayerNoiseScale(layerIdx: i32) -> f32 {
        if (layerIdx == 0) { return params.layerLow_noiseScale; }
        else if (layerIdx == 1) { return params.layerMid_noiseScale; }
        return params.layerHigh_noiseScale;
      }

      fn getLayerExtinction(layerIdx: i32) -> f32 {
        if (layerIdx == 0) { return params.layerLow_extinction; }
        else if (layerIdx == 1) { return params.layerMid_extinction; }
        return params.layerHigh_extinction;
      }

      fn getLayerAlbedo(layerIdx: i32) -> f32 {
        if (layerIdx == 0) { return params.layerLow_albedo; }
        else if (layerIdx == 1) { return params.layerMid_albedo; }
        return params.layerHigh_albedo;
      }

      fn hasActiveLayers() -> bool {
        return (params.layerLow_coverage > 0.01 && params.layerLow_altMax > params.layerLow_altMin) ||
               (params.layerMid_coverage > 0.01 && params.layerMid_altMax > params.layerMid_altMin) ||
               (params.layerHigh_coverage > 0.01 && params.layerHigh_altMax > params.layerHigh_altMin);
      }

      fn getLocalCloudCoord(worldPos: vec3<f32>, tileSize: f32, verticalStretch: f32) -> vec3<f32> {
        let rel = worldPos - params.planetCenter;
        let n = normalize(rel);
        let radial = dot(rel, n);
        let baseCoord = rel / tileSize;
        let vs = max(verticalStretch, 0.1);
        let radialScale = (1.0 / vs) - 1.0;
        return baseCoord + n * (radial / tileSize) * radialScale;
      }

      fn applyVerticalStretch(worldPos: vec3<f32>, verticalStretch: f32) -> vec3<f32> {
        let rel = worldPos - params.planetCenter;
        let n = normalize(rel);
        let radial = dot(rel, n);
        let vs = max(verticalStretch, 0.1);
        let radialScale = (1.0 / vs) - 1.0;
        return params.planetCenter + rel + n * radial * radialScale;
      }

      fn getGrazingDensityFactor(worldPos: vec3<f32>, rayDir: vec3<f32>) -> f32 {
        let surfaceNormal = normalize(worldPos - params.planetCenter);
        let NdotR = abs(dot(surfaceNormal, rayDir));
        return clamp(NdotR, 0.05, 1.0);
      }

      fn getSceneDepth(uv: vec2<f32>) -> f32 {
        let depthDims = textureDimensions(sceneDepthTexture);
        let uvDepth = vec2<f32>(uv.x, 1.0 - uv.y);
        let coord = vec2<i32>(uvDepth * vec2<f32>(f32(depthDims.x), f32(depthDims.y)));
        let clampedCoord = clamp(coord, vec2<i32>(0), vec2<i32>(depthDims) - vec2<i32>(1));
        return textureLoad(sceneDepthTexture, clampedCoord, 0);
      }

      fn linearizeDepth(depth: f32, near: f32, far: f32) -> f32 {
        return (near * far) / (far - depth * (far - near));
      }

      fn softenSunTransmittance(alt: f32, sunZenith: f32, sunTrans: vec3<f32>) -> vec3<f32> {
        let atmoHeight = max(atmo.atmosphereRadius - params.planetRadius, 1.0);
        let altNorm = clamp(alt / atmoHeight, 0.0, 1.0);
        let terminatorWidth = mix(0.7, 0.18, altNorm);
        let terminatorCenter = mix(-0.25, -0.08, altNorm);
        let sunVisibility = smoothstep(terminatorCenter - terminatorWidth, terminatorCenter + terminatorWidth, sunZenith);
        let twilightFloor = mix(vec3<f32>(0.06, 0.07, 0.09), vec3<f32>(0.01, 0.015, 0.02), altNorm);
        return mix(twilightFloor, sunTrans, sunVisibility);
      }

      fn computeInscatter(startPos: vec3<f32>, viewDir: vec3<f32>, distance: f32, sunDir: vec3<f32>) -> vec3<f32> {
        let steps = 4;
        let stepSize = distance / f32(steps);
        var inscatter = vec3<f32>(0.0);
        var trans = vec3<f32>(1.0);

        let cosTheta = dot(viewDir, sunDir);
        let phaseR = ap_rayleighPhase(cosTheta);
        let phaseM = ap_miePhase(cosTheta, atmo.mieAnisotropy);

        for (var i = 0; i < steps; i++) {
          let t = f32(i) * stepSize;
          let pos = startPos + viewDir * t;
          let alt = getAltitude(pos);
          let density = ap_getDensity(alt, atmo.scaleHeightRayleigh, atmo.scaleHeightMie);

          let scattering = atmo.rayleighScattering * density.x * phaseR + vec3<f32>(atmo.mieScattering) * density.y * phaseM;
          let extinction = atmo.rayleighScattering * density.x + vec3<f32>(atmo.mieScattering) * density.y * 1.1;

          let up = normalize(pos - params.planetCenter);
          let sunZen = dot(up, sunDir);
          let sunTransRaw = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, alt, sunZen, params.planetRadius, atmo.atmosphereRadius);
          let sunTrans = softenSunTransmittance(alt, sunZen, sunTransRaw);

          inscatter += trans * scattering * sunTrans * params.sunIntensity * stepSize;
          trans *= exp(-extinction * stepSize);
        }

        return inscatter;
      }

      // === density ===
      fn sampleLayerDensity(worldPos: vec3<f32>, altitude: f32, layerIdx: i32, lod: f32, rayDir: vec3<f32>, sunDir: vec3<f32>) -> f32 {
        let lp = getLayerParams(altitude, layerIdx);
        let coverage = lp.x;
        let densityMult = lp.y;
        let worleyInfluence = lp.z;
        let edgeSoftness = lp.w;

        if (coverage < 0.01) { return 0.0; }

        let noiseScale = getLayerNoiseScale(layerIdx);
        let verticalStretch = getLayerVerticalStretch(layerIdx);

        let w = sampleWeather(worldPos);

        let globalOffset = vec3<f32>(params.windOffsetX, 0.0, params.windOffsetY);
        let weatherWind = (w.ba * 2.0 - vec2<f32>(1.0, 1.0));
        let localTurb = weatherWind * params.time * TIME_SCALE * 2.0;
        let windOffset = globalOffset + vec3<f32>(localTurb.x, 0.0, localTurb.y);
        let animPos = worldPos - windOffset;

        let scaledTileSize = params.baseTileSize / max(noiseScale, 0.1);
        let baseCoord = getLocalCloudCoord(animPos, scaledTileSize, verticalStretch);

        let lodFactor = 1.0 - clamp(params.lodSteps / 128.0, 0.0, 1.0);
        let distToCam = length(worldPos - matrices.cameraPosition);
        let distLod = clamp(distToCam / 15000.0, 0.0, 2.0);
        let effectiveLod = max(lod, max(distLod * 0.4, lodFactor * 1.0));

        var finalBaseCoord = baseCoord;
        if (effectiveLod < 1.5) {
          finalBaseCoord = flowAdvect(baseCoord, params.time * TIME_SCALE * 0.02, 0.6, 0.5);
          finalBaseCoord = domainWarp(finalBaseCoord, 0.04);
        }

        let baseSample = sampleNoise3D(noiseBase, finalBaseCoord, effectiveLod);

        let combinedBase = mix(baseSample.r, baseSample.g, worleyInfluence * 0.5);
        let coverageMod = mix(0.85, 1.15, baseSample.b);

        let weatherCoverage = mix(0.4, 1.2, w.r);
        let effCoverage = clamp(coverage * weatherCoverage * coverageMod, 0.0, 1.0);

        let thresholdNoise = baseSample.b * 0.15;
        let softThreshold = (1.0 - effCoverage) - thresholdNoise;

        var shape = remap(combinedBase, softThreshold, 1.0, 0.0, 1.0);
        shape = clamp(shape, 0.0, 1.0) * densityMult;

        if (lod > 0.3 || shape < 0.01 || params.lodSteps < 48.0) {
          return max(0.0, shape * getGrazingDensityFactor(worldPos, rayDir));
        }

        let detailTile = params.detailTileSize / max(noiseScale, 0.1);
        let detailCoord = getLocalCloudCoord(animPos, detailTile, verticalStretch) + vec3<f32>(0.37, 0.11, 0.73);
        let adv = flowAdvect(detailCoord, params.time * TIME_SCALE * 0.035, 0.8, 0.35);
        let warped = domainWarp(adv, 0.03);
        let detailSample = sampleNoise3D(noiseDetail, warped, effectiveLod * 0.5);

        let detailHigh = detailSample.g;

        let cauliflower = clamp(getLayerCauliflower(layerIdx), 0.0, 1.0);
        if (cauliflower > 0.001) {
          let hFrac = clamp(getHeightFraction(worldPos), 0.0, 1.0);

          let detailWorley = detailSample.r;
          let detailHigh2  = detailSample.g;

          let detail2 = sampleNoise3D(noiseDetail, warped * 1.9 + vec3<f32>(0.19, 0.71, 0.37), effectiveLod * 0.65).r;
          let billowBase = mix(detailWorley, detail2, 0.45);
          let billowRidge = ridgeNoise(billowBase);

          let edgeish = clamp(1.0 - smoothstep(0.25, 0.85, shape), 0.0, 1.0);
          let topBias = smoothstep(0.25, 0.85, hFrac);

          let up = normalize(worldPos - params.planetCenter);
          let sunFacing = clamp(dot(up, sunDir) * 0.5 + 0.5, 0.0, 1.0);
          let lightBias = mix(0.75, 1.15, sunFacing);

          let variation = 0.75 + 0.5 * baseSample.b;

          var billowStrength =
              cauliflower * variation
              * mix(0.15, 1.0, topBias)
              * mix(0.35, 1.0, edgeish)
              * lightBias;

          shape = clamp(shape + billowRidge * billowStrength * (0.10 + 0.35 * shape), 0.0, 1.0);
          shape = clamp(shape * (0.96 + (detailHigh2 - 0.5) * billowStrength * 0.08), 0.0, 1.0);
        }

        shape = clamp(shape + (detailHigh - 0.5) * 0.04, 0.0, 1.0);

        if (params.lodSteps >= 64.0 && shape > 0.01) {
          let erosionCoord = getLocalCloudCoord(animPos, params.erosionTileSize, verticalStretch) + vec3<f32>(0.61, 0.29, 0.19);
          let warpedErosion = domainWarp(erosionCoord, 0.03);
          let erosionSample = textureSampleLevel(noiseErosion, noiseSamplerRepeat, warpedErosion, 0.0);

          let edgeMask = 1.0 - smoothstep(0.1, 0.5, shape);

          let hFrac = clamp(getHeightFraction(worldPos), 0.0, 1.0);
          let heightWorleyMod = smoothstep(0.2, 0.8, hFrac);

          let wispStrength = (1.0 - edgeSoftness) * 0.08 * (0.5 + heightWorleyMod * 0.5);
          let worleyCarve = (1.0 - erosionSample.r) * wispStrength * edgeMask;
          let curlWarp    = (erosionSample.b - 0.5) * wispStrength * 0.5 * edgeMask;

          shape = max(0.0, shape - worleyCarve + curlWarp);
        }

        if (shape < 0.01) { return 0.0; }
        return shape * getGrazingDensityFactor(worldPos, rayDir);
      }

      fn sampleCloudDensity(worldPos: vec3<f32>, lod: f32, rayDir: vec3<f32>, sunDir: vec3<f32>) -> f32 {
        let alt = getAltitude(worldPos);
        var d = 0.0;

        if (alt >= params.layerLow_altMin && alt <= params.layerLow_altMax) {
          d = max(d, sampleLayerDensity(worldPos, alt, 0, lod, rayDir, sunDir));
        }
        if (params.volumetricLowOnly < 0.5) {
          if (alt >= params.layerMid_altMin && alt <= params.layerMid_altMax) {
            d = max(d, sampleLayerDensity(worldPos, alt, 1, lod, rayDir, sunDir));
          }
        }

        return d;
      }

      fn getBlendedExtinction(alt: f32) -> f32 {
        if (!hasActiveLayers()) { return 0.035; }
        var tw = 0.0;
        var be = 0.0;
        for (var i = 0; i < 3; i++) {
          if (params.volumetricLowOnly > 0.5 && i > 0) { continue; }
          let lp = getLayerParams(alt, i);
          if (lp.x > 0.01) { be += getLayerExtinction(i) * lp.x; tw += lp.x; }
        }
        if (tw > 0.01) { return be / tw; }
        return 0.035;
      }

      fn getBlendedAlbedo(alt: f32) -> f32 {
        if (!hasActiveLayers()) { return 1.0; }
        var tw = 0.0;
        var ba = 0.0;
        for (var i = 0; i < 3; i++) {
          if (params.volumetricLowOnly > 0.5 && i > 0) { continue; }
          let lp = getLayerParams(alt, i);
          if (lp.x > 0.01) { ba += getLayerAlbedo(i) * lp.x; tw += lp.x; }
        }
        if (tw > 0.01) { return ba / tw; }
        return 1.0;
      }

      fn sampleLightEnergy(worldPos: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
        let lightSteps = u32(clamp(params.lodLightSteps, 2.0, 8.0));
        let layerThickness = params.cumulusOuterRadius - params.cumulusInnerRadius;
        let lightStepSize = layerThickness / f32(lightSteps);
        let lightLod = select(1.0, 2.0, params.lodLightSteps < 4.0);

        var opticalDepth = 0.0;
        for (var i = 0u; i < lightSteps; i++) {
          let stepT = (f32(i) + 0.5) * lightStepSize;
          let lp = worldPos + sunDir * stepT;
          let ld = sampleCloudDensity(lp, lightLod, sunDir, sunDir);
          opticalDepth += ld * lightStepSize;
        }

        let alt = getAltitude(worldPos);
        let up = normalize(worldPos - params.planetCenter);
        let sunZen = dot(up, sunDir);
        let sunRaw = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, alt, sunZen, params.planetRadius, atmo.atmosphereRadius);
        let sunAtmos = softenSunTransmittance(alt, sunZen, sunRaw);

        let absorptionCoeff = 0.018;
        let beer   = exp(-opticalDepth * absorptionCoeff);
        let powder = 1.0 - exp(-opticalDepth * absorptionCoeff * 2.0);

        let ms = 1.0 - exp(-opticalDepth * 0.08);
        let multiScatterBoost = 0.35 * ms;

        let lightIntensity = mix(beer, powder * 0.4 + beer * 0.6, 0.35) + multiScatterBoost;
        return sunAtmos * lightIntensity;
      }

      fn pickReprojectionT(tNear: f32, tFar: f32, firstHitT: f32, foundCloud: bool) -> f32 {
        if (!foundCloud) {
          return tNear + (tFar - tNear) * 0.35;
        }
        let marchDist = tFar - tNear;
        let pushed = firstHitT + marchDist * 0.35;
        return clamp(pushed, tNear + marchDist * 0.10, tFar - marchDist * 0.10);
      }

      // NEW: Check for active volume intersection (for future use in tiered rendering)
      fn getActiveVolumeCount() -> u32 {
        return volumeParams.activeCount;
      }

      @fragment
      fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let rayDir = getRayDirection(uv);
        let rayOrigin = matrices.cameraPosition;
        let sunDir = normalize(vec3<f32>(params.sunDirX, params.sunDirY, params.sunDirZ));

        var innerRadius = params.cumulusInnerRadius;
        var outerRadius = params.cumulusOuterRadius;

        var minAlt = innerRadius - params.planetRadius;
        var maxAlt = outerRadius - params.planetRadius;

        if (hasActiveLayers()) {
          if (params.layerLow_coverage > 0.01 && params.layerLow_altMax > 0.0) {
            minAlt = min(minAlt, params.layerLow_altMin);
            maxAlt = max(maxAlt, params.layerLow_altMax);
          }
          if (params.volumetricLowOnly < 0.5) {
            if (params.layerMid_coverage > 0.01 && params.layerMid_altMax > 0.0) {
              minAlt = min(minAlt, params.layerMid_altMin);
              maxAlt = max(maxAlt, params.layerMid_altMax);
            }
          }
        }

        innerRadius = params.planetRadius + minAlt;
        outerRadius = params.planetRadius + maxAlt;

        let layerThickness = outerRadius - innerRadius;
        let extendedInner = innerRadius - layerThickness * 0.1;
        let extendedOuter = outerRadius + layerThickness * 0.05;

        let hit = rayShellIntersect(rayOrigin, rayDir, params.planetCenter, extendedInner, extendedOuter);
        if (hit.y < 0.0) { return vec4<f32>(0.0); }

        var tNear = hit.x;
        var tFar = hit.y;

        let sceneDepthValue = getSceneDepth(uv);
        let near = 1.0;
        let far = params.planetRadius * 3.0;
        let linearDepth = linearizeDepth(sceneDepthValue, near, far);

        if (linearDepth < tNear && sceneDepthValue < 0.9999) {
          return vec4<f32>(0.0);
        }
        if (sceneDepthValue < 0.9999) {
          tFar = min(tFar, linearDepth);
        }

        let planetHit = rayPlanetIntersect(rayOrigin, rayDir, params.planetCenter, params.planetRadius);
        if (planetHit > 0.0) {
          if (planetHit <= tNear) { return vec4<f32>(0.0); }
          tFar = min(tFar, planetHit);
        }

        let maxMarchDist = max(params.cumulusOuterRadius * 0.5, 50000.0);
        tFar = min(tFar, tNear + maxMarchDist);

        let marchDist = tFar - tNear;
        if (marchDist < 1.0) { return vec4<f32>(0.0); }

        let frameOff = vec2<f32>(f32(u32(params.frameIndex) % 4u) * 2.0,
                                 f32(u32(params.frameIndex) / 4u % 4u) * 2.0);
        let dither = bayer8(uv * vec2<f32>(params.viewportWidth, params.viewportHeight) + frameOff);

        let baseBudget = clamp(params.lodSteps, 24.0, 128.0);
        let distNorm = clamp(marchDist / 35000.0, 0.0, 1.0);
        let totalBudget = u32(clamp(mix(baseBudget * 0.45, baseBudget, distNorm), 16.0, 128.0));

        let smallStep = marchDist / f32(totalBudget);
        let skipBoost = mix(4.0, 2.5, clamp(marchDist / 35000.0, 0.0, 1.0));
        let largeStep = smallStep * skipBoost;

        var t = tNear + smallStep * dither;

        var transmittance = 1.0;
        var color = vec3<f32>(0.0);
        var firstHitT = tFar;
        var foundCloud = false;
        var stepsUsed = 0u;
        var inCloud = false;
        var emptySteps = 0u;

        let cosAngle = dot(rayDir, sunDir);
        let phase = ap_miePhase(cosAngle, params.cloudAnisotropy);

        let ambientTop    = vec3<f32>(0.85, 0.92, 1.05);
        let ambientBottom = vec3<f32>(0.45, 0.50, 0.58);

        loop {
          if (stepsUsed >= totalBudget) { break; }
          if (t >= tFar) { break; }
          if (foundCloud && transmittance < 0.02) { break; }

          let pos = rayOrigin + rayDir * t;

          let density = sampleCloudDensity(pos, select(0.0, 1.0, !inCloud), rayDir, sunDir);

          let edgeMask = smoothstep(0.006, 0.022, density);
          let currentStep = mix(largeStep, smallStep, edgeMask);

          if (edgeMask > 0.0) {
            if (!inCloud && !foundCloud) {
              t = max(tNear, t - currentStep);
              inCloud = true;
              emptySteps = 0u;
              continue;
            }

            inCloud = true;
            emptySteps = 0u;

            if (!foundCloud) {
              firstHitT = t;
              foundCloud = true;
            }

            let alt = getAltitude(pos);
            let layerExt = getBlendedExtinction(alt);
            let layerAlb = getBlendedAlbedo(alt);

            let sigmaE = (density * edgeMask) * layerExt;
            let sampleExt = exp(-sigmaE * currentStep);

            let h = clamp(getHeightFraction(pos), 0.0, 1.0);
            let lightEnergy = sampleLightEnergy(pos, sunDir);

            let phaseMod = mix(1.0, phase, 0.55);
            let direct = lightEnergy * phaseMod * layerAlb;

            let ambient = mix(ambientBottom, ambientTop, h);
            let lightLuma = dot(lightEnergy, vec3<f32>(0.299, 0.587, 0.114));
            let ambientOcc = mix(0.6, 1.0, lightLuma);
            let ambientLight = ambient * 0.75 * ambientOcc * layerAlb;

            let totalLight = direct + ambientLight;

            let opacity = (1.0 - sampleExt) * edgeMask;
            let scatter = totalLight * opacity;

            color += transmittance * scatter;
            transmittance *= sampleExt;

          } else {
            if (inCloud) {
              emptySteps++;
              if (emptySteps > 3u) { inCloud = false; }
            }
          }

          t += currentStep;
          stepsUsed++;
        }

        var alpha = 1.0 - transmittance;
        alpha = pow(alpha, 1.15);

        if (alpha > 0.001) {
          let cloudDist = max(0.0, firstHitT);

          let fogIns = computeInscatter(rayOrigin, rayDir, cloudDist, sunDir);

          let simpleTrans = exp(-cloudDist * 0.00002);
          color = color * simpleTrans + fogIns * alpha;

          let cloudPos = rayOrigin + rayDir * firstHitT;
          let apResult = ap_computeSimple(
            transmittanceLUT, noiseSamplerClamp,
            cloudPos, rayOrigin, sunDir,
            params.planetCenter, params.planetRadius, atmo.atmosphereRadius,
            atmo.scaleHeightRayleigh, atmo.scaleHeightMie,
            atmo.rayleighScattering, atmo.mieScattering,
            atmo.mieAnisotropy, params.sunIntensity
          );

          let apDist = length(cloudPos - rayOrigin);
          let apBlend = 1.0 - exp(-apDist * 0.00003);

          color = ap_applyWithBlend(color, apResult, apBlend * 0.5);
          alpha *= (1.0 - apBlend * 0.25);
        }

        var distFade = 1.0;
        if (foundCloud) {
          let cloudDist = max(0.0, firstHitT);
          distFade = 1.0 - smoothstep(maxMarchDist * 0.75, maxMarchDist * 1.00, cloudDist);
        }
        alpha *= distFade;
        color *= distFade;

        let camAlt = getAltitude(rayOrigin);
        if (camAlt > maxAlt) {
          let fadeRange = max(1500.0, layerThickness * 0.5);
          let aboveFade = smoothstep(maxAlt, maxAlt + fadeRange, camAlt);
          let vFade = 1.0 - aboveFade;
          color *= vFade;
          alpha *= vFade;
        }

        if (params.historyValid > 0.5 && alpha > 0.003) {
          let reprojectT = pickReprojectionT(tNear, tFar, firstHitT, foundCloud);
          let wpos = rayOrigin + rayDir * reprojectT;
          let prevClip = matrices.prevViewProj * vec4<f32>(wpos, 1.0);

          if (prevClip.w > 0.001) {
            let ndc = prevClip.xyz / prevClip.w;
            let prevUV = ndc.xy * 0.5 + vec2<f32>(0.5, 0.5);
            let hist = sampleHistory(prevUV);

            if (hist.a > 0.005) {
              var blend = params.historyBlend;
              let cDiff = length(color - hist.rgb);
              let aDiff = abs(alpha - hist.a);
              if (cDiff > 0.8 || aDiff > 0.6) { blend *= 0.2; }
              color = mix(color, hist.rgb, blend);
              alpha = mix(alpha, hist.a, blend);
            }
          }
        }

        let edgeFade = smoothstep(0.003, 0.08, alpha);
        color *= edgeFade;
        alpha *= edgeFade;
        return vec4<f32>(color, alpha);
      }
        `;
    }

    _getCirrusFragmentShader() {
        // Cirrus shader remains mostly unchanged, just add the common code import
        const cloudCommon = getCloudCommonWGSL();
        const settings = this._cirrusQualitySettings || this._getCirrusQualitySettings();
        this._cirrusQualitySettings = settings;
        const qualityTag = `// cirrus-quality:${settings.key}\n`;
        
        return /* wgsl */`
    ${qualityTag}${AERIAL_PERSPECTIVE_WGSL}
    ${cloudCommon}

    struct MatrixUniforms {
        inverseView: mat4x4<f32>,
        inverseProjection: mat4x4<f32>,
        cameraPosition: vec3<f32>,
        _pad0: f32,
        prevViewProj: mat4x4<f32>
    };

    struct CloudParams {
        planetCenter: vec3<f32>,
        planetRadius: f32,
        cumulusInnerRadius: f32,
        cumulusOuterRadius: f32,
        cirrusInnerRadius: f32,
        cirrusOuterRadius: f32,
        sunDirX: f32,
        sunDirY: f32,
        sunDirZ: f32,
        sunIntensity: f32,
        coverage: f32,
        time: f32,
        windSpeed: f32,
        cloudAnisotropy: f32,
        windDirX: f32,
        windDirY: f32,
        baseTileSize: f32,
        detailTileSize: f32,
        erosionTileSize: f32,
        historyBlend: f32,
        historyValid: f32,
        weatherType: f32,
        lodSteps: f32,
        lodLightSteps: f32,
        frameIndex: f32,
        renderScale: f32,
        windOffsetX: f32,
        windOffsetY: f32,
        volumetricLowOnly: f32,
        viewportWidth: f32,
        viewportHeight: f32,
        _pad3: vec4<f32>,
        _pad4: vec4<f32>,
        _pad5: vec4<f32>,
        layerLow_altMin: f32, layerLow_altMax: f32, layerLow_coverage: f32, layerLow_densityMult: f32,
        layerLow_noiseScale: f32, layerLow_verticalStretch: f32, layerLow_worleyInfluence: f32, layerLow_edgeSoftness: f32,
        layerLow_extinction: f32, layerLow_albedo: f32, layerLow_cauliflower: f32,
        layerLow_pad0: f32, layerLow_pad1: f32, layerLow_pad2: f32, layerLow_pad3: f32, layerLow_pad4: f32,

        layerMid_altMin: f32, layerMid_altMax: f32, layerMid_coverage: f32, layerMid_densityMult: f32,
        layerMid_noiseScale: f32, layerMid_verticalStretch: f32, layerMid_worleyInfluence: f32, layerMid_edgeSoftness: f32,
        layerMid_extinction: f32, layerMid_albedo: f32, layerMid_cauliflower: f32,
        layerMid_pad0: f32, layerMid_pad1: f32, layerMid_pad2: f32, layerMid_pad3: f32, layerMid_pad4: f32,

        layerHigh_altMin: f32, layerHigh_altMax: f32, layerHigh_coverage: f32, layerHigh_densityMult: f32,
        layerHigh_noiseScale: f32, layerHigh_verticalStretch: f32, layerHigh_worleyInfluence: f32, layerHigh_edgeSoftness: f32,
        layerHigh_extinction: f32, layerHigh_albedo: f32, layerHigh_cauliflower: f32,
        layerHigh_pad0: f32, layerHigh_pad1: f32, layerHigh_pad2: f32, layerHigh_pad3: f32, layerHigh_pad4: f32,

        // Volume tuning (extended cloud params)
        volumeTierAMaxDist: f32,
        volumeTierBMaxDist: f32,
        volumeFadeStart: f32,
        volumeFadeEnd: f32,
        volumeCellSize: f32,
        volumeFogCellSize: f32,
        volumeMinCoverage: f32,
        volumeDebugFlags: f32,
        volumePad: array<vec4<f32>, 14>,
    };

    struct AtmosphereParams {
        atmosphereRadius: f32,
        scaleHeightRayleigh: f32,
        scaleHeightMie: f32,
        mieAnisotropy: f32,
        rayleighScattering: vec3<f32>,
        mieScattering: f32,
        _pad0: vec4<f32>,
    };

    @group(0) @binding(0) var<uniform> matrices: MatrixUniforms;
    @group(0) @binding(1) var<uniform> params: CloudParams;
    @group(0) @binding(2) var<uniform> atmo: AtmosphereParams;

    @group(1) @binding(0) var noiseBase: texture_3d<f32>;
    @group(1) @binding(1) var noiseDetail: texture_3d<f32>;
    @group(1) @binding(2) var noiseErosion: texture_3d<f32>;
    @group(1) @binding(3) var noiseSamplerRepeat: sampler;
    @group(1) @binding(4) var transmittanceLUT: texture_2d<f32>;
    @group(1) @binding(5) var noiseSamplerClamp: sampler;

    const TIME_SCALE: f32 = 0.066;
    const CIRRUS_TIME_MULT: f32 = 1.0;
    const CIRRUS_FLOW_PASSES: i32 = ${settings.flowPasses};
    const CIRRUS_WARP_STRENGTH: f32 = ${settings.warpStrength};
    const CIRRUS_BASE_LOD: f32 = ${settings.baseLod};
    const CIRRUS_DETAIL_LOD: f32 = ${settings.detailLod};
    const CIRRUS_EROSION_LOD: f32 = ${settings.erosionLod};
    const CIRRUS_DETAIL_FREQ: f32 = ${settings.detailFreq};
    const CIRRUS_EROSION_FREQ: f32 = ${settings.erosionFreq};
    const CIRRUS_USE_EROSION: bool = ${settings.useErosion};
    const CIRRUS_EXTRA_DETAIL: bool = ${settings.extraDetail};
    const CIRRUS_EXTRA_DETAIL_FREQ: f32 = ${settings.extraDetailFreq};
    const CIRRUS_EXTRA_DETAIL_LOD: f32 = ${settings.extraDetailLod};
    const CIRRUS_EXTRA_DETAIL_WEIGHT: f32 = ${settings.extraDetailWeight};

    fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
        let clip = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
        let view = matrices.inverseProjection * clip;
        let world = matrices.inverseView * vec4<f32>(view.xyz / view.w, 0.0);
        return normalize(world.xyz);
    }

    fn sampleNoise3D(tex: texture_3d<f32>, coord: vec3<f32>, lod: f32) -> vec4<f32> {
        return textureSampleLevel(tex, noiseSamplerRepeat, fract(coord), lod);
    }

    fn domainWarp(coord: vec3<f32>, strength: f32) -> vec3<f32> {
        let warpSample = sampleNoise3D(noiseErosion, coord * 0.25, 2.0).xyz;
        let warp = (warpSample - vec3<f32>(0.5)) * strength;
        return coord + warp;
    }

    fn softenSunTransmittance(alt: f32, sunZenith: f32, sunTrans: vec3<f32>) -> vec3<f32> {
        let atmoHeight = max(atmo.atmosphereRadius - params.planetRadius, 1.0);
        let altNorm = clamp(alt / atmoHeight, 0.0, 1.0);
        let terminatorWidth = mix(0.7, 0.18, altNorm);
        let terminatorCenter = mix(-0.25, -0.08, altNorm);
        let sunVisibility = smoothstep(terminatorCenter - terminatorWidth, terminatorCenter + terminatorWidth, sunZenith);
        let twilightFloor = mix(vec3<f32>(0.06, 0.07, 0.09), vec3<f32>(0.01, 0.015, 0.02), altNorm);
        return mix(twilightFloor, sunTrans, sunVisibility);
    }

    fn flowAdvect(coord: vec3<f32>, time: f32, speed: f32, strength: f32) -> vec3<f32> {
        let flowSample = sampleNoise3D(noiseErosion, coord * 0.12 + vec3<f32>(time * speed, 0.0, time * speed), 1.0).xy;
        let flow = (flowSample - vec2<f32>(0.5)) * 2.0;
        return coord + vec3<f32>(flow.x, 0.0, flow.y) * strength;
    }

    fn rayShellIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, rInner: f32, rOuter: f32) -> vec2<f32> {
        return cloudRayShellIntersect(ro, rd, center, rInner, rOuter);
    }

    fn getAltitude(worldPos: vec3<f32>) -> f32 {
        return length(worldPos - params.planetCenter) - params.planetRadius;
    }

  @fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rayDir = getRayDirection(uv);
    let rayOrigin = matrices.cameraPosition;
    let sunDir = normalize(vec3<f32>(params.sunDirX, params.sunDirY, params.sunDirZ));

    if (params.layerHigh_coverage <= 0.01 || params.layerHigh_altMax <= params.layerHigh_altMin) {
        return vec4<f32>(0.0);
    }

    let innerR = params.planetRadius + params.layerHigh_altMin;
    let outerR = params.planetRadius + params.layerHigh_altMax;
    let band = outerR - innerR;
    let midR = (innerR + outerR) * 0.5;
    let camAlt = getAltitude(rayOrigin);
    let distToCenter = length(rayOrigin - params.planetCenter);

    // ---- Stable sample position via mid-altitude sphere intersection ----
    // This avoids the discontinuous tMid jump at the inner-sphere tangent angle.
    let oc = rayOrigin - params.planetCenter;
    let bCoeff = dot(oc, rayDir);
    let cCoeff = dot(oc, oc) - midR * midR;
    let disc = bCoeff * bCoeff - cCoeff;

    if (disc < 0.0) { return vec4<f32>(0.0); }

    let sqrtDisc = sqrt(disc);
    let tMid0 = -bCoeff - sqrtDisc;
    let tMid1 = -bCoeff + sqrtDisc;

    // Pick near hit when outside, far hit when inside (continuous at boundary)
    var tSample: f32;
    if (tMid0 > 0.01) {
        tSample = tMid0;
    } else if (tMid1 > 0.01) {
        tSample = tMid1;
    } else {
        return vec4<f32>(0.0);
    }

    // Also check the outer sphere to reject rays that miss the shell entirely
    let cOuter = dot(oc, oc) - outerR * outerR;
    let discOuter = bCoeff * bCoeff - cOuter;
    if (discOuter < 0.0) { return vec4<f32>(0.0); }

    // Reject rays blocked by the planet
    let cPlanet = dot(oc, oc) - params.planetRadius * params.planetRadius;
    let discPlanet = bCoeff * bCoeff - cPlanet;
    if (discPlanet >= 0.0) {
        let tPlanet = -bCoeff - sqrt(discPlanet);
        if (tPlanet > 0.0 && tPlanet < tSample) {
            return vec4<f32>(0.0);
        }
    }

    let pos = rayOrigin + rayDir * tSample;

    // ---- Noise sampling (unchanged from original) ----
    let noiseScale = max(params.layerHigh_noiseScale, 0.1);
    let tileSize = params.baseTileSize * 5.0 / noiseScale;

    let rel = pos - params.planetCenter;
    let upDir = normalize(rel);

    var east = cross(vec3<f32>(0.0, 1.0, 0.0), upDir);
    if (length(east) < 0.1) {
        east = cross(vec3<f32>(1.0, 0.0, 0.0), upDir);
    }
    east = normalize(east);
    let north = normalize(cross(upDir, east));

    let wind2 = normalize(vec2<f32>(params.windOffsetX, params.windOffsetY) + vec2<f32>(0.001, 0.0));
    let windDir = normalize(east * wind2.x + north * wind2.y);
    let sideDir = normalize(cross(upDir, windDir));

    let along = dot(rel, windDir);
    let across = dot(rel, sideDir);
    let vertical = dot(rel, upDir);

    let stretch = 4.0;
    let squish = 0.5;
    let p = windDir * along * stretch + sideDir * across * squish + upDir * vertical * 0.35;

    let cirrusTime = params.time * TIME_SCALE * CIRRUS_TIME_MULT;
    let windDrift = vec3<f32>(params.windOffsetX * 0.0001, 0.0, params.windOffsetY * 0.0001);

    let coord = p / tileSize + windDrift * cirrusTime;

    var flowCoord = coord;
    if (CIRRUS_WARP_STRENGTH > 0.0) {
        flowCoord = domainWarp(flowCoord, CIRRUS_WARP_STRENGTH);
    }
    if (CIRRUS_FLOW_PASSES >= 1) {
        flowCoord = flowAdvect(flowCoord, cirrusTime * 0.15, 0.4, 0.35);
    }
    if (CIRRUS_FLOW_PASSES >= 2) {
        flowCoord = flowAdvect(flowCoord + vec3<f32>(0.5, 0.3, 0.7), cirrusTime * 0.08, 0.3, 0.2);
    }
    if (CIRRUS_FLOW_PASSES >= 3) {
        flowCoord = flowAdvect(flowCoord + vec3<f32>(0.17, 0.53, 0.31), cirrusTime * 0.05, 0.25, 0.15);
    }

    let n0 = sampleNoise3D(noiseBase, flowCoord + vec3<f32>(0.17, 0.23, 0.13), CIRRUS_BASE_LOD).r;
    var n1 = sampleNoise3D(noiseDetail, flowCoord * CIRRUS_DETAIL_FREQ + vec3<f32>(0.51, 0.07, 0.29), CIRRUS_DETAIL_LOD).r;
    var n2: f32 = 0.5;
    if (CIRRUS_USE_EROSION) {
        n2 = sampleNoise3D(noiseErosion, flowCoord * CIRRUS_EROSION_FREQ + vec3<f32>(0.11, 0.67, 0.41), CIRRUS_EROSION_LOD).r;
    }
    if (CIRRUS_EXTRA_DETAIL) {
        let n1b = sampleNoise3D(noiseDetail, flowCoord * CIRRUS_EXTRA_DETAIL_FREQ + vec3<f32>(0.21, 0.61, 0.43), CIRRUS_EXTRA_DETAIL_LOD).r;
        n1 = mix(n1, n1b, CIRRUS_EXTRA_DETAIL_WEIGHT);
    }

    let ridge = 1.0 - abs(n1 * 2.0 - 1.0);

    let coverage = clamp(params.layerHigh_coverage, 0.0, 1.0);
    let coverageT = min(coverage, 0.65);

    let ridgeInfluence = mix(0.7, 0.45, coverageT);
    let fbm = n0 * (1.0 - ridgeInfluence) + ridge * ridgeInfluence + n2 * 0.12;

    let thresh = mix(0.42, 0.18, coverageT);
    var shape = smoothstep(thresh, 0.8, fbm);
    let ridgeMask = smoothstep(0.18, 0.85, ridge);
    let gapNoise = smoothstep(0.12, 0.85, n2);
    shape *= mix(0.6, 1.0, ridgeMask) * mix(0.7, 1.0, gapNoise);

    // ---- Lighting (unchanged) ----
    let alt = getAltitude(pos);
    let up = normalize(pos - params.planetCenter);
    let sunZenith = dot(up, sunDir);
    let sunTransRaw = ap_sampleTransmittance(transmittanceLUT, noiseSamplerClamp, alt, sunZenith, params.planetRadius, atmo.atmosphereRadius);
    let sunTrans = softenSunTransmittance(alt, sunZenith, sunTransRaw);

    let cosAngle = dot(rayDir, sunDir);
    let phase = ap_miePhase(cosAngle, params.cloudAnisotropy);
    let intensity = mix(0.7, 1.2, phase);
    let ambientCirrus = vec3<f32>(0.6, 0.65, 0.7);

    let sunBrightness = max(max(sunTrans.r, sunTrans.g), sunTrans.b);
    let neutralSunTrans = mix(vec3<f32>(sunBrightness), sunTrans, 0.35);
    let color = max(neutralSunTrans, vec3<f32>(0.3)) * params.layerHigh_albedo * intensity + ambientCirrus * 0.45;

    var alpha = shape * coverage * 1.2;

    // ---- Horizon fade (geometric-horizon-aware) ----
    let camUp = normalize(rayOrigin - params.planetCenter);
    let cosViewUp = dot(rayDir, camUp);
    let cosGeoHorizon = -sqrt(max(0.0, 1.0 - (params.planetRadius / distToCenter)
                                            * (params.planetRadius / distToCenter)));
    let cirrusAltFrac = clamp(camAlt / max(params.layerHigh_altMax, 1.0), 0.0, 1.0);
    let cirrusFadeW = mix(0.06, 0.005, sqrt(cirrusAltFrac));
    let horizonFade = smoothstep(cosGeoHorizon - cirrusFadeW,
                                  cosGeoHorizon + cirrusFadeW * 2.0,
                                  cosViewUp);
    alpha *= horizonFade;

    // ---- Smooth altitude fade (replaces shellEdgeFade + old inside logic) ----
    let transitionW = band * 0.35;

    if (camAlt > params.layerHigh_altMin && camAlt < params.layerHigh_altMax) {
        // Inside shell: fade to transparent near boundaries, reduce overall
        let distToNearBound = min(camAlt - params.layerHigh_altMin,
                                   params.layerHigh_altMax - camAlt);
        let boundaryFade = smoothstep(0.0, transitionW, distToNearBound);
        alpha *= boundaryFade * 0.3;
    } else if (camAlt <= params.layerHigh_altMin) {
        // Below shell: fade out when very close to the base (looking up into it)
        let distBelow = params.layerHigh_altMin - camAlt;
        let approachFade = smoothstep(0.0, transitionW * 0.3, distBelow);
        alpha *= mix(0.3, 1.0, approachFade);
    } else {
        // Above shell: fade out when very close to the top (looking down into it)
        let distAbove = camAlt - params.layerHigh_altMax;
        let approachFade = smoothstep(0.0, transitionW * 0.3, distAbove);
        alpha *= mix(0.3, 1.0, approachFade);
    }

    // ---- Grazing-ray fade (thin shell path at extreme angles) ----
    // Replaces shellEdgeFade: use the angle between ray and shell normal
    let surfaceNormal = normalize(pos - params.planetCenter);
    let grazingAngle = abs(dot(rayDir, surfaceNormal));
    let grazingFade = smoothstep(0.0, 0.08, grazingAngle);
    alpha *= grazingFade;

    let finalAlpha = clamp(alpha, 0.0, 1.0);
    return vec4<f32>(color * finalAlpha, finalAlpha);
}
        `;
    }
}
