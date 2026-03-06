/**
 * ALC 板材智能配模核心算法 v4.0
 * 约束条件：
 * 1. 固定模高 1200mm，层数 = 1200/厚度 (必须整除，否则向下取整并警告)
 * 2. 模数必须为整数。
 * 3. 总产出 = 模数 × 层数。若总产出 > 需求，差值需回写为“补充张数”。
 * 4. 组合策略：仅限单板或双板。严禁三板。
 * 5. 优先级：双板(利用率>=80%) > 双板(利用率<80%但优于单板) > 同尺寸双板(仅当剩余量大) > 单板。
 * 6. 同一模内所有层组合必须一致。
 */

const ALC_ALGORITHM = {
    VERSION: '4.0.1-Remote',
    FIXED_MOLD_HEIGHT: 1200,

    /**
     * 主计算入口
     * @param {Array} data - 原始板材数据 [{id, length, width, thickness, quantity, project}]
     * @param {number} templateLength - 模板长度 (6000 or 5400)
     * @param {number} selectedThickness - 用户选择的厚度
     * @returns {Object} { results: [], updates: [], stats: {} }
     */
    calculate: function(data, templateLength, selectedThickness) {
        console.log(`[ALC Algo] 开始计算 | 模板:${templateLength}mm, 厚度:${selectedThickness}mm`);

        // 1. 基础参数校验与计算
        const layers = Math.floor(this.FIXED_MOLD_HEIGHT / selectedThickness);
        if (layers === 0) {
            throw new Error(`厚度 ${selectedThickness}mm 超过模高 ${this.FIXED_MOLD_HEIGHT}mm，无法计算！`);
        }
        const remainderHeight = this.FIXED_MOLD_HEIGHT % selectedThickness;
        if (remainderHeight > 0) {
            console.warn(`[ALC Algo] 警告：模高剩余 ${remainderHeight}mm 废料，有效层数=${layers}`);
        }

        // 2. 构建需求池 (打散为单个需求单元，但保留原始ID引用)
        // 结构：{ id, length, width, thickness, project, originalIndex, needed: true }
        let pool = [];
        data.forEach((item, idx) => {
            for (let k = 0; k < item.quantity; k++) {
                pool.push({
                    ...item,
                    originalIndex: idx,
                    uid: `${idx}-${k}` // 唯一标识
                });
            }
        });

        // 按长度降序排序，利于贪心匹配
        pool.sort((a, b) => b.length - a.length);

        let molds = []; // 存储生成的模具方案：{ specs: [item, item?], count: 1 }
        let usedPoolIndices = new Set(); // 记录已使用的池子索引 (这里直接用对象引用更简单，我们用 splice)

        // 3. 核心循环：直到池子为空
        while (pool.length > 0) {
            // 取出当前最长的一个作为基准 (Base)
            const baseItem = pool.shift(); 
            let bestCombination = null;
            let bestScore = -1; // 分数越高越好

            // --- 策略 A: 寻找最佳双板搭档 ---
            // 遍历剩余池子，寻找 partner
            for (let i = 0; i < pool.length; i++) {
                const partner = pool[i];
                const totalLen = baseItem.length + partner.length;

                if (totalLen <= templateLength) {
                    const utilization = totalLen / templateLength;
                    const isSameSize = (baseItem.length === partner.length);
                    
                    // 评分逻辑
                    let score = utilization * 100; // 基础分：利用率
                    
                    // 惩罚项：同尺寸组合 (除非利用率极高，接近100%)
                    if (isSameSize && utilization < 0.98) {
                        score -= 50; // 大幅降低同尺寸优先级
                    }
                    
                    // 奖励项：利用率 >= 80%
                    if (utilization >= 0.80) {
                        score += 20;
                    }

                    // 只有分数高于当前最佳才更新
                    if (score > bestScore) {
                        bestScore = score;
                        bestCombination = {
                            type: 'double',
                            specs: [baseItem, partner],
                            utilization: utilization,
                            partnerIndex: i
                        };
                    }
                }
            }

            // --- 策略 B: 评估是否强制使用双板 (即使分数不高) vs 单板 ---
            // 如果找到了双板，但利用率极低 (<60%)，且基座本身长度 > 模板的 70%，则考虑退回单板
            let finalMoldSpecs = [];
            let finalUtilization = 0;
            let removedPartnerIndex = -1;

            if (bestCombination) {
                if (bestCombination.utilization >= 0.60) {
                    // 接受双板
                    finalMoldSpecs = bestCombination.specs;
                    finalUtilization = bestCombination.utilization;
                    removedPartnerIndex = bestCombination.partnerIndex;
                } else {
                    // 双板利用率太低，尝试单板逻辑
                    // 检查单板利用率
                    const singleUtil = baseItem.length / templateLength;
                    if (singleUtil > bestCombination.utilization) {
                        // 单板更优，放弃双板
                        finalMoldSpecs = [baseItem];
                        finalUtilization = singleUtil;
                    } else {
                        // 虽然双板低，但比单板好，还是用双板 (防止极短料浪费)
                        finalMoldSpecs = bestCombination.specs;
                        finalUtilization = bestCombination.utilization;
                        removedPartnerIndex = bestCombination.partnerIndex;
                    }
                }
            } else {
                // 没找到任何搭档，只能单板
                finalMoldSpecs = [baseItem];
                finalUtilization = baseItem.length / templateLength;
            }

            // 执行移除操作
            if (removedPartnerIndex !== -1) {
                pool.splice(removedPartnerIndex, 1);
            }

            molds.push({
                specs: finalMoldSpecs,
                utilization: finalUtilization
            });
        }

        // 4. 结果聚合与模数计算 (关键步骤)
        // 将相同的组合模式合并，计算需要的模数
        // Key: 排序后的长度字符串 "L1-L2" or "L1"
        let patternMap = {};

        molds.forEach(mold => {
            // 生成长度特征Key
            const lengths = mold.specs.map(s => s.length).sort((a,b) => b-a);
            const key = lengths.join('-');
            
            if (!patternMap[key]) {
                patternMap[key] = {
                    patternLengths: lengths,
                    sampleSpecs: mold.specs, // 样本数据用于显示项目名等
                    rawCount: 0, // 原始需要的模具次数 (基于单张累加)
                    totalSheetsPerSpec: {} // 统计该模式下每种规格需要的总张数
                };
            }
            
            patternMap[key].rawCount++;
            // 统计该模式下各规格出现的频次
            mold.specs.forEach(s => {
                const sKey = `${s.length}-${s.width}-${s.project}`;
                patternMap[key].totalSheetsPerSpec[sKey] = (patternMap[key].totalSheetsPerSpec[sKey] || 0) + 1;
            });
        });

        // 5. 整数模数换算与补充量计算
        let finalResults = [];
        let updates = []; // 需要回写到前端的补充数据 { originalIndex, addQty }

        Object.values(patternMap).forEach((p, idx) => {
            // 计算该模式下，单个规格需求的最大模数
            // 逻辑：对于该模式中的每个规格，我们需要满足它的总需求量
            // 但该模式是绑定的。例如模式 A+B。如果我们需要 10 个 A 和 8 个 B。
            // 每模产出 1A+1B。则需要 max(10, 8) = 10 模。
            // 产出：10A + 10B。多余 2B。
            
            // 重新遍历原始 molds 可能会更准确，但我们已经聚合了 rawCount (这是基于完美匹配的假设)
            // 修正逻辑：我们需要根据该 Pattern 覆盖的原始需求来计算真正的 Mold Count
            
            // 简单化算法：由于我们在生成 molds 时是贪心的，rawCount 其实就是该模式出现的次数。
            // 但是，为了满足“整数模数”且“覆盖所有需求”，我们需要向上取整吗？
            // 其实上面的 while 循环已经保证了所有需求都被分配到了某个 mold 中。
            // 现在的任务是：把相同的 mold 合并。
            // 合并后，模数 = rawCount。
            // 等等，用户的需求是：如果计算出来需要 10.5 模，必须取 11 模，多出的算补充。
            // 但在我们的离散算法中，rawCount 已经是整数了。
            // 这里的“补充”逻辑通常发生在：用户输入的总数不能被 (层数*每模个数) 整除时？
            // 不，用户的逻辑是：我们按“模”生产。
            // 假设需求 10 张。层数 6。每模含 1 张该规格。
            // 需要 10/6 = 1.66 -> 2 模。
            // 产出 12 张。补充 2 张。
            
            // 让我们重新计算每个 Pattern 的真正模数需求
            // 收集该 Pattern 涉及的所有原始规格的需求总量
            // 由于我们在第一步已经把 pool 拆散了，现在的 rawCount 是基于“单次切割”的。
            // 比如：需求 10 张 3000mm。算法生成了 10 次包含 3000mm 的模具。
            // 如果这 10 次都是同样的组合 (3000+2800)。那么 rawCount=10。
            // 此时：总产出张数 = 10 (模) * 1 (每模该规格数量) * layers (层数)。
            // 原始需求 = 10 * layers ? 不对。
            // 原始需求是 10 张。我们在 pool 里放了 10 个对象。
            // 算法生成了 10 个模具。
            // 实际生产时，我们开 10 模？
            // 1 模 = layers 张。
            // 如果我们要切 10 张，层数是 6。我们需要 ceil(10/6) = 2 模。
            // 但算法生成了 10 个“单张级”的模具记录。这需要合并。
            
            // 修正聚合逻辑：
            // 统计该 Pattern 中，每种规格被选中的总次数 (totalHits)
            // 对于规格 X，总需求张数 = totalHits (因为 pool 是按张拆的)
            // 需要的模数 = ceil(totalHits / layers) ??? 
            // 不，这样会打乱组合。
            // 正确的逻辑：
            // 我们的算法是基于“根” (Template Length) 的。
            // 每一根模具 (Layer) 切出特定的组合。
            // 我们有 layers 层叠在一起切。
            // 所以 1 模 = layers 根。
            // 如果算法算出需要 10 根 (rawCount=10) 这种组合。
            // 那么模数 = ceil(10 / layers)。
            // 产生的总根数 = 模数 * layers。
            // 多余的根数 = (模数 * layers) - 10。
            // 这些多余的根数，意味着多切了 多余的根数 * 每根包含的规格数 张板材。
            
            const rootsNeeded = p.rawCount; // 需要的总根数
            const moldCount = Math.ceil(rootsNeeded / layers); // 向上取整得到整数模数
            const rootsProduced = moldCount * layers; // 实际生产的总根数
            const extraRoots = rootsProduced - rootsNeeded; // 多余的根数

            // 计算补充张数
            // 每根根数里包含的规格数量 (通常是1或2)
            p.sampleSpecs.forEach(spec => {
                const extraSheets = extraRoots * 1; // 每根里该规格出现1次 (如果是双板，每个规格在各自信中出现1次)
                // 注意：如果是双板 A+B。extraRoots 根意味着多了 extraRoots 个 A 和 extraRoots 个 B。
                
                if (extraSheets > 0) {
                    // 找到该规格对应的原始 ID
                    // 由于 sampleSpecs 只保留了样本，我们需要标记补充量
                    // 这里我们返回一个更新指令
                    updates.push({
                        originalIndex: spec.originalIndex,
                        addQty: extraSheets,
                        reason: `因模数取整 (共${moldCount}模)，自动补充`
                    });
                }
            });

            finalResults.push({
                id: idx + 1,
                patternStr: p.patternLengths.join(' + ') + ' mm',
                moldCount: moldCount,
                layers: layers,
                utilization: (p.sampleSpecs.reduce((sum, s) => sum + s.length, 0) / templateLength * 100).toFixed(2),
                templateLen: templateLength,
                details: p.sampleSpecs.map(s => ({
                    length: s.length,
                    width: s.width,
                    thickness: s.thickness,
                    project: s.project,
                    sheetsPerMold: layers, // 每模产出
                    totalRootsInPattern: rootsProduced // 该方案总根数
                }))
            });
        });

        return {
            results: finalResults,
            updates: updates,
            stats: {
                totalMolds: finalResults.reduce((sum, r) => sum + r.moldCount, 0),
                avgUtil: finalResults.reduce((sum, r) => sum + parseFloat(r.utilization), 0) / finalResults.length
            }
        };
    }
};

// 导出模块 (兼容 CommonJS 和 浏览器全局)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ALC_ALGORITHM;
}