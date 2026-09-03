import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


class ArgsFileContractTest(unittest.TestCase):
    """args_file はパスだけを渡して中身を args として読み、inline のキーがそれを上書きする。

    毎周回 30〜70KB を打ち直す経路そのものが写し間違いの温床なので、その経路を消す。
    """

    def test_both_scripts_read_args_file_and_inline_wins(self) -> None:
        for name in ("refine.js", "draft.js"):
            source = (SCRIPTS / name).read_text()
            self.assertIn("parsedArgs.args_file", source, f"{name} が args_file を読まない")
            self.assertIn(
                "parsedArgs = { ...fromFile, ...inline }",
                source,
                f"{name} で inline が args_file を上書きしない",
            )

    def test_merge_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "args.json"
            path.write_text(json.dumps({"skillDir": "/from/file", "mode": "expand"}))
            script = (
                "const fs=require('fs');"
                "let parsedArgs={args_file:process.argv[1],skillDir:'/inline'};"
                "if(parsedArgs.args_file){"
                "const fromFile=JSON.parse(fs.readFileSync(parsedArgs.args_file,'utf8'));"
                "const {args_file, ...inline}=parsedArgs;"
                "parsedArgs={...fromFile, ...inline};}"
                "console.log(JSON.stringify(parsedArgs));"
            )
            out = subprocess.run(
                ["node", "-e", script, str(path)], capture_output=True, text=True, check=True
            )
            merged = json.loads(out.stdout)
            self.assertEqual(merged["mode"], "expand")
            self.assertEqual(merged["skillDir"], "/inline")
            self.assertNotIn("args_file", merged)


if __name__ == "__main__":
    unittest.main()
