CREATE OR REPLACE FUNCTION ensure_apparel_reference_match_catalog() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_category uuid;
  v_demo boolean := false;
  v_ref_svc uuid;
  v_comp_svc uuid;
  v_cap uuid;
  v_author uuid;
  v_reviewer uuid;
  v_sub record;
  v_src_content jsonb;
  v_ref_content jsonb;
  v_ref_checks jsonb;
  v_comp_tpl uuid;
  v_comp_content jsonb;
  v_tpl uuid;
  v_offer uuid;
  v_inserted integer := 0;
BEGIN
  SELECT id, COALESCE((admission_snapshot->>'demo')::boolean, false)
    INTO v_category, v_demo
    FROM categories WHERE slug = 'apparel';
  IF v_category IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_ref_svc FROM service_types WHERE code = 'reference_match';
  SELECT id INTO v_comp_svc FROM service_types WHERE code = 'compare';

  SELECT id INTO v_cap FROM capabilities WHERE approved_by IS NOT NULL AND revoked_at IS NULL ORDER BY id LIMIT 1;
  IF v_cap IS NULL THEN
    RETURN 0;
  END IF;

  SELECT author_id, reviewer_id INTO v_author, v_reviewer
    FROM template_versions
    WHERE category_id = v_category AND state = 'PUBLISHED' AND reviewer_id IS NOT NULL AND reviewer_id <> author_id
    ORDER BY published_at DESC NULLS LAST, version DESC LIMIT 1;
  IF v_author IS NULL OR v_reviewer IS NULL THEN
    SELECT sr1.user_id, sr2.user_id INTO v_author, v_reviewer
      FROM staff_roles sr1
      JOIN staff_roles sr2 ON sr2.user_id <> sr1.user_id
      WHERE sr1.role IN ('template_admin', 'super_admin')
        AND sr2.role IN ('reviewer', 'super_admin')
      ORDER BY sr1.user_id, sr2.user_id LIMIT 1;
  END IF;
  IF v_author IS NULL OR v_reviewer IS NULL THEN
    RETURN 0;
  END IF;

  v_ref_checks := '[
    {"key": "color_shade_match", "label": "Color & Fabric Shade Consistency vs. Reference", "zh": "与确认样色差及面辅料一致性", "kind": "observation", "type": "text", "required": true, "evidence": true, "method": "Place incoming garment side-by-side with sealed reference sample under D65 lighting; document observable shade or texture variance."},
    {"key": "stitching_construction_match", "label": "Stitching, Seam & Trim Construction vs. Reference", "zh": "车缝工艺与辅料还原度对比", "kind": "observation", "type": "text", "required": true, "evidence": true, "method": "Compare stitch density, seam construction, piping, and hardware trim against the sealed reference sample."},
    {"key": "label_trim_match", "label": "Label, Size & Artwork Match vs. Reference", "zh": "主唛尺码印花与确认样对比", "kind": "observation", "type": "text", "required": true, "evidence": true, "method": "Verify main label, care content marking, and graphic print placement against the sealed reference sample."}
  ]'::jsonb;

  FOR v_sub IN
    SELECT * FROM (VALUES
      ('tops', 'apparel-tops-inspection', 'apparel-tops-compare', 'apparel-tops-reference_match', 'apparel-sub-tops-reference_match-1', 'Tops & Knitwear Inspection', '上衣/针织衫专项质检', '{"en":"Tops & Knitwear · Golden Sample Matching","zh-CN":"上衣/针织衫 · 确认样对照"}'::jsonb),
      ('bottoms', 'apparel-bottoms-inspection', 'apparel-bottoms-compare', 'apparel-bottoms-reference_match', 'apparel-sub-bottoms-reference_match-1', 'Bottoms, Pants & Leggings Inspection', '裤装/紧身裤专项质检', '{"en":"Bottoms & Leggings · Golden Sample Matching","zh-CN":"裤装/紧身裤 · 确认样对照"}'::jsonb),
      ('sports_bra', 'apparel-sports-bra-inspection', 'apparel-sports-bra-compare', 'apparel-sports-bra-reference_match', 'apparel-sub-sports-bra-reference_match-1', 'Sports Bra & Intimate Activewear Inspection', '运动内衣专项质检', '{"en":"Sports Bras · Golden Sample Matching","zh-CN":"运动内衣 · 确认样对照"}'::jsonb)
    ) AS t(sub_slug, src_tpl_key, comp_tpl_key, ref_tpl_key, sku_code, base_en, base_zh, title_json)
  LOOP
    SELECT content INTO v_src_content
      FROM template_versions
      WHERE template_key = v_sub.src_tpl_key AND version = 1;
    IF v_src_content IS NULL THEN
      CONTINUE;
    END IF;

    -- Provision 2-item & 3-item compare subcategory offers where missing
    IF v_comp_svc IS NOT NULL THEN
      SELECT id INTO v_comp_tpl FROM template_versions WHERE template_key = v_sub.comp_tpl_key AND version = 1;
      IF v_comp_tpl IS NULL THEN
        v_comp_content := v_src_content || '{"order_shots":["side_by_side_front","side_by_side_back","detail_overlay"]}'::jsonb;
        INSERT INTO template_versions(template_key, category_id, service_type_id, version, content, content_hash, state, author_id, reviewer_id, published_at)
          VALUES(v_sub.comp_tpl_key, v_category, v_comp_svc, 1, v_comp_content, encode(sha256(convert_to(v_comp_content::text, 'UTF8')), 'hex'), 'PUBLISHED', v_author, v_reviewer, now())
          RETURNING id INTO v_comp_tpl;
        INSERT INTO template_capabilities(template_version_id, capability_id) VALUES(v_comp_tpl, v_cap) ON CONFLICT DO NOTHING;
        v_inserted := v_inserted + 1;
      END IF;

      SELECT id INTO v_offer FROM service_offers WHERE sku_code = 'apparel-sub-' || v_sub.sub_slug || '-compare-2';
      IF v_offer IS NULL THEN
        INSERT INTO service_offers(sku_code, service_type_id, title, enabled)
          VALUES('apparel-sub-' || v_sub.sub_slug || '-compare-2', v_comp_svc, jsonb_build_object('en', v_sub.base_en || ' · 2-Item Comparison', 'zh-CN', v_sub.base_zh || ' · 2件横向对比'), true)
          RETURNING id INTO v_offer;
        INSERT INTO offer_templates(offer_id, category_id, service_type_id, template_version_id)
          VALUES(v_offer, v_category, v_comp_svc, v_comp_tpl) ON CONFLICT DO NOTHING;
        INSERT INTO sku_prices(offer_id, version, currency, rules, effective_from)
          VALUES(v_offer, 1, 'USD', jsonb_build_object('minimum', 2, 'maximum', 2, 'package_cents', 6500, 'business_days', 3, 'demo', v_demo), now())
          ON CONFLICT DO NOTHING;
      END IF;

      SELECT id INTO v_offer FROM service_offers WHERE sku_code = 'apparel-sub-' || v_sub.sub_slug || '-compare-3';
      IF v_offer IS NULL THEN
        INSERT INTO service_offers(sku_code, service_type_id, title, enabled)
          VALUES('apparel-sub-' || v_sub.sub_slug || '-compare-3', v_comp_svc, jsonb_build_object('en', v_sub.base_en || ' · 3-Item Comparison', 'zh-CN', v_sub.base_zh || ' · 3件横向对比'), true)
          RETURNING id INTO v_offer;
        INSERT INTO offer_templates(offer_id, category_id, service_type_id, template_version_id)
          VALUES(v_offer, v_category, v_comp_svc, v_comp_tpl) ON CONFLICT DO NOTHING;
        INSERT INTO sku_prices(offer_id, version, currency, rules, effective_from)
          VALUES(v_offer, 1, 'USD', jsonb_build_object('minimum', 3, 'maximum', 3, 'package_cents', 7900, 'business_days', 3, 'demo', v_demo), now())
          ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    -- Provision Golden Sample Matching subcategory templates & offers
    IF v_ref_svc IS NOT NULL THEN
      v_ref_content := jsonb_set(
        v_src_content,
        '{checks}',
        COALESCE(v_src_content->'checks', '[]'::jsonb) || v_ref_checks
      );
      v_ref_content := jsonb_set(
        v_ref_content,
        '{shots}',
        COALESCE(v_src_content->'shots', '[]'::jsonb) || '[{"code":"reference_side_by_side","name":"Reference vs. Candidate Side-by-Side","zh":"确认样与来样同框照","required":true}]'::jsonb
      );

      SELECT id INTO v_tpl FROM template_versions WHERE template_key = v_sub.ref_tpl_key AND version = 1;
      IF v_tpl IS NULL THEN
        INSERT INTO template_versions(template_key, category_id, service_type_id, version, content, content_hash, state, author_id, reviewer_id, published_at)
          VALUES(v_sub.ref_tpl_key, v_category, v_ref_svc, 1, v_ref_content, encode(sha256(convert_to(v_ref_content::text, 'UTF8')), 'hex'), 'PUBLISHED', v_author, v_reviewer, now())
          RETURNING id INTO v_tpl;
        INSERT INTO template_capabilities(template_version_id, capability_id) VALUES(v_tpl, v_cap) ON CONFLICT DO NOTHING;
        v_inserted := v_inserted + 1;
      END IF;

      SELECT id INTO v_offer FROM service_offers WHERE sku_code = v_sub.sku_code;
      IF v_offer IS NULL THEN
        INSERT INTO service_offers(sku_code, service_type_id, title, enabled)
          VALUES(v_sub.sku_code, v_ref_svc, v_sub.title_json, true)
          RETURNING id INTO v_offer;
        INSERT INTO offer_templates(offer_id, category_id, service_type_id, template_version_id)
          VALUES(v_offer, v_category, v_ref_svc, v_tpl) ON CONFLICT DO NOTHING;
        INSERT INTO sku_prices(offer_id, version, currency, rules, effective_from)
          VALUES(v_offer, 1, 'USD', jsonb_build_object('minimum', 1, 'maximum', 1, 'package_cents', 3900, 'business_days', 3, 'demo', v_demo), now())
          ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN v_inserted;
END $$;

SELECT ensure_apparel_reference_match_catalog();
