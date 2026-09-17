import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from calculate import calculate


class QuoteTests(unittest.TestCase):
    def cost(self, **changes):
        return dict(mode='cost', procurement_cny=60000, procurement_source='采购确认',
                    ground_cny=2000, ground_source='燃油地面口径', profit_cny=12000,
                    profit_source='本单批准', cny_per_usd=6, fx_source='测试汇率', **changes)

    def test_unapproved_reserve_excluded_and_fixed_price_changes_margin(self):
        data = self.cost(extra=[dict(code='reserve', amount_cny=4000, approved=False, source='旧AI草稿')])
        result = calculate(data)
        self.assertEqual(result['recommended_usd'], '12333.33')
        self.assertEqual(result['cost_cny'], '62000.00')
        self.assertEqual(result['profit_at_rounded_price_cny'], '11999.98')
        data.update(fixed_price_usd=13000, fixed_price_source='本轮确认保留售价')
        self.assertEqual(calculate(data)['profit_at_rounded_price_cny'], '16000.00')

    def test_ground_cost_cannot_be_added_twice(self):
        with self.assertRaises(ValueError):
            calculate(self.cost(extra=[dict(code='ground', amount_cny=2000, approved=True, source='重复')]))

    def test_quantity_comparison_and_unknown_insurance(self):
        data = dict(mode='compare', unit_price_usd=17400, price_source='本单FOB', options=[
            dict(quantity=1, freight_usd=3000, freight_source='单台方案'),
            dict(quantity=2, freight_usd=4000, freight_source='两台方案')])
        one, two = calculate(data)['plans']
        self.assertEqual(one['total_usd'], '20400.00')
        self.assertEqual(one['insurance'], 'unknown_excluded')
        self.assertEqual(two['total_usd'], '38800.00')
        self.assertEqual(two['savings_per_vehicle_usd'], '1000.00')
        self.assertEqual(two['savings_total_usd'], '2000.00')
        self.assertEqual(two['additional_budget_usd'], '18400.00')
        data['options'][1].update(insurance_usd=100, insurance_source='测试保险')
        self.assertNotIn('savings_total_usd', calculate(data)['plans'][1])

    def test_cli_appends_readable_records_without_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'input.json'
            source.write_text(json.dumps(self.cost()))
            command = [sys.executable, str(Path(__file__).with_name('calculate.py')), str(source), '--out', folder]
            first = json.loads(subprocess.check_output(command))
            second = json.loads(subprocess.check_output(command))
            self.assertNotEqual(first['path'], second['path'])
            record = json.loads(Path(first['path']).read_text())
            self.assertEqual(record['input'], self.cost())
            self.assertEqual(record['result']['status'], 'draft')


if __name__ == '__main__':
    unittest.main()
